// Catalyst owns only a Metal presenter. libmpv and OpenGL never enter this process.
#import <UIKit/UIView.h>
#import <UIKit/UIColor.h>
#import <UIKit/UIWindow.h>
#import <UIKit/UIScreen.h>
#import <Metal/Metal.h>
#import <QuartzCore/CAMetalLayer.h>
#import <IOSurface/IOSurface.h>
#include <servers/bootstrap.h>
#include <stdatomic.h>
#include "video-wire.h"

@interface VRVideoView : UIView
@end
@implementation VRVideoView
+ (Class)layerClass { return [CAMetalLayer class]; }
@end

@interface VRVideoSurface : NSObject {
@public
    atomic_bool stopped;
    mach_port_t port;
    uint64_t token;
    uint64_t frames;
}
@property VRVideoView *view;
@property(weak) UIView *browser;
@property id<MTLCommandQueue> queue;
@property id<MTLRenderPipelineState> pipeline;
@property id<MTLTexture> texture;
@property uint32_t surfaceID;
- (void)receive:(VRVideoFrame)message;
- (void)reply:(mach_port_t)reply sequence:(uint32_t)sequence;
@end

@implementation VRVideoSurface
- (void)reply:(mach_port_t)reply sequence:(uint32_t)sequence {
    const CGSize size = self.view.bounds.size;
    const CGFloat scale = self.view.window.screen.scale ?: 2;
    VRVideoReply response = {0};
    response.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_MOVE_SEND_ONCE, 0);
    response.header.msgh_size = sizeof(response);
    response.header.msgh_remote_port = reply;
    response.header.msgh_id = VR_VIDEO_REPLY;
    response.version = VR_VIDEO_VERSION;
    response.sequence = sequence;
    response.width = (uint32_t)MAX(1, MIN(7680, round(size.width * scale)));
    response.height = (uint32_t)MAX(1, MIN(4320, round(size.height * scale)));
    response.visible = !atomic_load(&stopped) && !self.view.hidden && self.view.window != nil;
    const kern_return_t result = mach_msg(&response.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT,
        sizeof(response), 0, MACH_PORT_NULL, 0, MACH_PORT_NULL);
    if (result != KERN_SUCCESS) mach_msg_destroy(&response.header);
}
- (void)receive:(VRVideoFrame)message {
    const mach_port_t reply = message.header.msgh_remote_port;
    IOSurfaceRef surface = message.surface.name ? IOSurfaceLookupFromMachPort(message.surface.name) : NULL;
    if (message.surface.name) mach_port_deallocate(mach_task_self(), message.surface.name);
    if (!surface || atomic_load(&stopped) || self.view.hidden) {
        if (surface) CFRelease(surface);
        [self reply:reply sequence:message.sequence];
        return;
    }
    const size_t width = IOSurfaceGetWidth(surface), height = IOSurfaceGetHeight(surface);
    if (width < 1 || height < 1 || width > 7680 || height > 4320 || IOSurfaceGetBytesPerElement(surface) != 4) {
        CFRelease(surface);
        [self reply:reply sequence:message.sequence];
        return;
    }
    CAMetalLayer *layer = (CAMetalLayer *)self.view.layer;
    layer.drawableSize = CGSizeMake(width, height);
    if (self.surfaceID != IOSurfaceGetID(surface)) {
        MTLTextureDescriptor *description = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm
            width:width height:height mipmapped:NO];
        description.usage = MTLTextureUsageShaderRead;
        description.storageMode = MTLStorageModeShared;
        self.texture = [layer.device newTextureWithDescriptor:description iosurface:surface plane:0];
        self.surfaceID = IOSurfaceGetID(surface);
    }
    CFRelease(surface);
    id<CAMetalDrawable> drawable = [layer nextDrawable];
    if (!drawable || !self.texture) {
        [self reply:reply sequence:message.sequence];
        return;
    }
    MTLRenderPassDescriptor *pass = [MTLRenderPassDescriptor renderPassDescriptor];
    pass.colorAttachments[0].texture = drawable.texture;
    pass.colorAttachments[0].loadAction = MTLLoadActionDontCare;
    pass.colorAttachments[0].storeAction = MTLStoreActionStore;
    id<MTLCommandBuffer> commands = [self.queue commandBuffer];
    id<MTLRenderCommandEncoder> encoder = [commands renderCommandEncoderWithDescriptor:pass];
    [encoder setRenderPipelineState:self.pipeline];
    [encoder setFragmentTexture:self.texture atIndex:0];
    [encoder drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:3];
    [encoder endEncoding];
    [commands presentDrawable:drawable];
    [commands addCompletedHandler:^(id<MTLCommandBuffer> completed) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (completed.status == MTLCommandBufferStatusCompleted) self->frames++;
            [self reply:reply sequence:message.sequence];
        });
    }];
    [commands commit];
}
@end

static NSMutableDictionary<NSNumber *, VRVideoSurface *> *surfaces;

uint64_t vroom_video_create(void *browserHandle) {
    NSCAssert([NSThread isMainThread], @"Video surfaces belong to the UI thread");
    UIView *browser = (__bridge UIView *)browserHandle;
    if (!browser.superview) return 0;
    id<MTLDevice> device = MTLCreateSystemDefaultDevice();
    if (!device) return 0;
    NSError *error = nil;
    NSString *shader = @"#include <metal_stdlib>\nusing namespace metal;\n"
        "struct Vertex { float4 position [[position]]; float2 uv; };\n"
        "vertex Vertex videoVertex(uint i [[vertex_id]]) { float2 p = float2((i << 1) & 2, i & 2); "
        "return {float4(p * float2(2, -2) + float2(-1, 1), 0, 1), p}; }\n"
        "fragment float4 videoPixel(Vertex v [[stage_in]], texture2d<float> image [[texture(0)]]) { "
        "constexpr sampler s(filter::linear, address::clamp_to_edge); return image.sample(s, v.uv); }";
    id<MTLLibrary> library = [device newLibraryWithSource:shader options:nil error:&error];
    MTLRenderPipelineDescriptor *description = [MTLRenderPipelineDescriptor new];
    description.vertexFunction = [library newFunctionWithName:@"videoVertex"];
    description.fragmentFunction = [library newFunctionWithName:@"videoPixel"];
    description.colorAttachments[0].pixelFormat = MTLPixelFormatBGRA8Unorm;
    id<MTLRenderPipelineState> pipeline = [device newRenderPipelineStateWithDescriptor:description error:&error];
    if (!pipeline) { NSLog(@"Vroom Metal initialization: %@", error); return 0; }
    VRVideoSurface *surface = [VRVideoSurface new];
    surface.browser = browser;
    surface.queue = [device newCommandQueue];
    surface.pipeline = pipeline;
    surface.view = [[VRVideoView alloc] initWithFrame:CGRectMake(0, 0, 640, 360)];
    surface.view.userInteractionEnabled = NO;
    surface.view.hidden = YES;
    surface.view.backgroundColor = UIColor.blackColor;
    CAMetalLayer *layer = (CAMetalLayer *)surface.view.layer;
    layer.device = device;
    layer.pixelFormat = MTLPixelFormatBGRA8Unorm;
    layer.framebufferOnly = YES;
    CGColorSpaceRef color = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    layer.colorspace = color;
    CGColorSpaceRelease(color);
    arc4random_buf(&surface->token, sizeof(surface->token));
    surface->token &= INT64_MAX;
    if (!surface->token) surface->token = 1;
    if (mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE, &surface->port) != KERN_SUCCESS) return 0;
    if (mach_port_insert_right(mach_task_self(), surface->port, surface->port, MACH_MSG_TYPE_MAKE_SEND) != KERN_SUCCESS) {
        mach_port_mod_refs(mach_task_self(), surface->port, MACH_PORT_RIGHT_RECEIVE, -1); return 0;
    }
    char name[128];
    snprintf(name, sizeof(name), "app.vroom.video.%d.%llu", getpid(), surface->token);
    // Public Mach bootstrap API. The service lives only as long as this receive
    // right; no launch agent, privileged daemon, global IOSurface ID or private API.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    const kern_return_t registered = bootstrap_register(bootstrap_port, name, surface->port);
#pragma clang diagnostic pop
    if (registered != KERN_SUCCESS) {
        mach_port_mod_refs(mach_task_self(), surface->port, MACH_PORT_RIGHT_RECEIVE, -1);
        mach_port_deallocate(mach_task_self(), surface->port); return 0;
    }
    if (!surfaces) surfaces = [NSMutableDictionary new];
    surfaces[@(surface->token)] = surface;
    [browser.superview insertSubview:surface.view belowSubview:browser];
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INTERACTIVE, 0), ^{
        while (!atomic_load(&surface->stopped)) {
            struct { VRVideoFrame message; mach_msg_max_trailer_t trailer; } buffer = {0};
            const kern_return_t result = mach_msg(&buffer.message.header,
                MACH_RCV_MSG | MACH_RCV_TIMEOUT | MACH_RCV_TRAILER_TYPE(MACH_MSG_TRAILER_FORMAT_0) |
                MACH_RCV_TRAILER_ELEMENTS(MACH_RCV_TRAILER_SENDER), 0, sizeof(buffer), surface->port, 100, MACH_PORT_NULL);
            if (result == MACH_RCV_TIMED_OUT) continue;
            if (result != KERN_SUCCESS) break;
            const VRVideoFrame message = buffer.message;
            const mach_msg_security_trailer_t *trailer = (const void *)((const char *)&buffer + round_msg(message.header.msgh_size));
            if (message.header.msgh_id != VR_VIDEO_MESSAGE || message.header.msgh_size != sizeof(VRVideoFrame) ||
                message.version != VR_VIDEO_VERSION || message.body.msgh_descriptor_count != 1 ||
                message.surface.type != MACH_MSG_PORT_DESCRIPTOR || !message.header.msgh_remote_port ||
                trailer->msgh_trailer_size < sizeof(*trailer) || trailer->msgh_sender.val[0] != geteuid()) {
                mach_msg_destroy(&buffer.message.header); continue;
            }
            dispatch_async(dispatch_get_main_queue(), ^{ [surface receive:message]; });
        }
    });
    return surface->token;
}

void vroom_video_update(uint64_t token, double left, double top, double width, double height, int visible) {
    VRVideoSurface *surface = surfaces[@(token)];
    if (!surface) return;
    const CGRect browser = surface.browser.frame;
    surface.view.frame = CGRectMake(browser.origin.x + left, browser.origin.y + top, MAX(1, width), MAX(1, height));
    surface.view.hidden = !visible || width < 1 || height < 1;
}

uint64_t vroom_video_frames(uint64_t token) {
    VRVideoSurface *surface = surfaces[@(token)];
    return surface ? surface->frames : 0;
}

void vroom_video_destroy(uint64_t token) {
    VRVideoSurface *surface = surfaces[@(token)];
    if (!surface) return;
    atomic_store(&surface->stopped, true);
    mach_port_mod_refs(mach_task_self(), surface->port, MACH_PORT_RIGHT_RECEIVE, -1);
    mach_port_deallocate(mach_task_self(), surface->port);
    [surface.view removeFromSuperview];
    [surfaces removeObjectForKey:@(token)];
}
