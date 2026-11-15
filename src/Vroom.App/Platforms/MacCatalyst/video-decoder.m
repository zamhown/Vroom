// One ordinary macOS process per player. The public libmpv render API writes an
// OpenGL FBO backed by IOSurface. The Catalyst host samples it with Metal.
#define GL_SILENCE_DEPRECATION
#import <Foundation/Foundation.h>
#import <IOSurface/IOSurface.h>
#import <OpenGL/OpenGL.h>
#import <OpenGL/gl3.h>
#import <OpenGL/CGLIOSurface.h>
#include <mpv/client.h>
#include <mpv/render_gl.h>
#include <servers/bootstrap.h>
#include <dlfcn.h>
#include <sys/resource.h>
#include "video-wire.h"

static void fail(const char *operation, int error) {
    fprintf(stderr, "Vroom decoder: %s (%d)\n", operation, error);
    exit(70);
}
static void check(int error) { if (error < 0) { fprintf(stderr, "%s\n", mpv_error_string(error)); fail("libmpv", error); } }
static void *gl_address(void *context, const char *name) { (void)context; return dlsym(RTLD_DEFAULT, name); }
static void wake(void *context) { dispatch_semaphore_signal((__bridge dispatch_semaphore_t)context); }

static VRVideoReply exchange(mach_port_t host, mach_port_t reply, IOSurfaceRef surface, uint32_t sequence) {
    VRVideoFrame frame = {0};
    frame.header.msgh_bits = MACH_MSGH_BITS_COMPLEX | MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, MACH_MSG_TYPE_MAKE_SEND_ONCE);
    frame.header.msgh_size = sizeof(frame);
    frame.header.msgh_remote_port = host;
    frame.header.msgh_local_port = reply;
    frame.header.msgh_id = VR_VIDEO_MESSAGE;
    frame.body.msgh_descriptor_count = 1;
    frame.surface.type = MACH_MSG_PORT_DESCRIPTOR;
    frame.surface.disposition = MACH_MSG_TYPE_MOVE_SEND;
    frame.surface.name = surface ? IOSurfaceCreateMachPort(surface) : MACH_PORT_NULL;
    frame.version = VR_VIDEO_VERSION;
    frame.sequence = sequence;
    kern_return_t result = mach_msg(&frame.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, sizeof(frame), 0, MACH_PORT_NULL, 1000, MACH_PORT_NULL);
    if (result != KERN_SUCCESS) { mach_msg_destroy(&frame.header); fail("send surface", result); }
    struct { VRVideoReply value; mach_msg_max_trailer_t trailer; } response = {0};
    result = mach_msg(&response.value.header, MACH_RCV_MSG | MACH_RCV_TIMEOUT, 0, sizeof(response), reply, 10000, MACH_PORT_NULL);
    if (result != KERN_SUCCESS) fail("presenter disconnected", result);
    if (response.value.header.msgh_id != VR_VIDEO_REPLY || response.value.header.msgh_size != sizeof(VRVideoReply) ||
        response.value.version != VR_VIDEO_VERSION || response.value.sequence != sequence ||
        response.value.width < 1 || response.value.width > 7680 || response.value.height < 1 || response.value.height > 4320)
        fail("invalid presentation reply", 1);
    return response.value;
}

static IOSurfaceRef target(CGLContextObj context, uint32_t width, uint32_t height, GLuint *texture, GLuint framebuffer) {
    NSDictionary *properties = @{
        (id)kIOSurfaceWidth: @(width), (id)kIOSurfaceHeight: @(height),
        (id)kIOSurfaceBytesPerElement: @4,
        (id)kIOSurfaceBytesPerRow: @(IOSurfaceAlignProperty(kIOSurfaceBytesPerRow, width * 4)),
        (id)kIOSurfacePixelFormat: @(0x42475241),
    };
    IOSurfaceRef surface = IOSurfaceCreate((__bridge CFDictionaryRef)properties);
    if (!surface) fail("create IOSurface", 1);
    if (*texture) glDeleteTextures(1, texture);
    glGenTextures(1, texture);
    glBindTexture(GL_TEXTURE_RECTANGLE, *texture);
    glTexParameteri(GL_TEXTURE_RECTANGLE, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_RECTANGLE, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    const CGLError error = CGLTexImageIOSurface2D(context, GL_TEXTURE_RECTANGLE, GL_RGBA8, width, height,
        GL_BGRA, GL_UNSIGNED_INT_8_8_8_8_REV, surface, 0);
    if (error != kCGLNoError) fail("attach IOSurface", error);
    glBindFramebuffer(GL_FRAMEBUFFER, framebuffer);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_RECTANGLE, *texture, 0);
    if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) fail("incomplete framebuffer", 1);
    return surface;
}

int main(int argc, char **argv) {
    @autoreleasepool {
        if (argc == 2 && strcmp(argv[1], "--capabilities") == 0) {
            CGLPixelFormatAttribute attributes[] = { kCGLPFAOpenGLProfile, (CGLPixelFormatAttribute)kCGLOGLPVersion_3_2_Core,
                kCGLPFAAccelerated, kCGLPFAAllowOfflineRenderers, (CGLPixelFormatAttribute)0 };
            CGLPixelFormatObj format = NULL; CGLContextObj context = NULL; GLint count = 0;
            const bool available = CGLChoosePixelFormat(attributes, &format, &count) == kCGLNoError && format &&
                CGLCreateContext(format, NULL, &context) == kCGLNoError;
            if (context) CGLReleaseContext(context);
            if (format) CGLReleasePixelFormat(format);
            printf("{\"protocol\":%d,\"gpu\":%s}\n", VR_VIDEO_VERSION, available ? "true" : "false");
            return 0;
        }
        if (argc == 2 && strcmp(argv[1], "--version") == 0) {
            printf("Vroom IOSurface decoder protocol %d / libmpv API %lu\n", VR_VIDEO_VERSION, mpv_client_api_version());
            return 0;
        }
        const char *service = NULL;
        const char *ipc = NULL;
        mpv_handle *mpv = mpv_create();
        if (!mpv) fail("create libmpv", 1);
        for (int i = 1; i < argc; i++) {
            if (strncmp(argv[i], "--vroom-surface=", 16) == 0) { service = argv[i] + 16; continue; }
            if (strncmp(argv[i], "--input-ipc-server=", 19) == 0) { ipc = argv[i] + 19; continue; }
            if (strncmp(argv[i], "--", 2) != 0) fail("invalid option", 1);
            const char *equals = strchr(argv[i] + 2, '=');
            NSString *key = equals ? [[NSString alloc] initWithBytes:argv[i] + 2 length:equals - argv[i] - 2 encoding:NSUTF8StringEncoding]
                : [NSString stringWithUTF8String:argv[i] + 2];
            const bool negative = !equals && [key hasPrefix:@"no-"];
            if (negative) key = [key substringFromIndex:3];
            const int configured = mpv_set_option_string(mpv, key.UTF8String, equals ? equals + 1 : negative ? "no" : "yes");
            if (configured < 0) fprintf(stderr, "Vroom decoder option: %s\n", key.UTF8String);
            check(configured);
        }
        if (!service || strncmp(service, "app.vroom.video.", 16) != 0 || strlen(service) >= 128) fail("missing presenter", 1);
        mach_port_t host = MACH_PORT_NULL, reply = MACH_PORT_NULL;
        kern_return_t result = bootstrap_look_up(bootstrap_port, service, &host);
        if (result != KERN_SUCCESS) fail("find presenter", result);
        result = mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE, &reply);
        if (result != KERN_SUCCESS) fail("create reply port", result);
        check(mpv_set_option_string(mpv, "vo", "libmpv"));
        check(mpv_initialize(mpv));

        CGLPixelFormatAttribute attributes[] = { kCGLPFAOpenGLProfile, (CGLPixelFormatAttribute)kCGLOGLPVersion_3_2_Core,
            kCGLPFAAccelerated, kCGLPFAAllowOfflineRenderers, (CGLPixelFormatAttribute)0 };
        CGLPixelFormatObj format = NULL;
        GLint count = 0;
        CGLError error = CGLChoosePixelFormat(attributes, &format, &count);
        if (error != kCGLNoError || !format) fail("OpenGL pixel format", error);
        CGLContextObj context = NULL;
        error = CGLCreateContext(format, NULL, &context);
        CGLReleasePixelFormat(format);
        if (error != kCGLNoError) fail("OpenGL context", error);
        CGLSetCurrentContext(context);
        mpv_opengl_init_params gl = { .get_proc_address = gl_address };
        mpv_render_param initialization[] = {
            { MPV_RENDER_PARAM_API_TYPE, MPV_RENDER_API_TYPE_OPENGL },
            { MPV_RENDER_PARAM_OPENGL_INIT_PARAMS, &gl }, {0}
        };
        mpv_render_context *renderer = NULL;
        check(mpv_render_context_create(&renderer, mpv, initialization));
        dispatch_semaphore_t signal = dispatch_semaphore_create(0);
        mpv_set_wakeup_callback(mpv, wake, (__bridge void *)signal);
        mpv_render_context_set_update_callback(renderer, wake, (__bridge void *)signal);
        // Do not admit loadfile before the render context exists: libmpv's VO
        // initialization and render-context registration can otherwise deadlock.
        if (ipc) check(mpv_set_property_string(mpv, "input-ipc-server", ipc));
        GLuint framebuffer = 0, texture = 0;
        glGenFramebuffers(1, &framebuffer);
        IOSurfaceRef surface = NULL;
        uint32_t sequence = 0, width = 0, height = 0;
        VRVideoReply geometry = exchange(host, reply, NULL, ++sequence);
        bool running = true, redraw = true;
        uint64_t frames = 0;
        const double started = CFAbsoluteTimeGetCurrent();
        while (running) {
            @autoreleasepool {
                dispatch_semaphore_wait(signal, dispatch_time(DISPATCH_TIME_NOW, 100 * NSEC_PER_MSEC));
                while (dispatch_semaphore_wait(signal, DISPATCH_TIME_NOW) == 0) {}
                for (;;) {
                    mpv_event *event = mpv_wait_event(mpv, 0);
                    if (event->event_id == MPV_EVENT_NONE) break;
                    if (event->event_id == MPV_EVENT_SHUTDOWN) running = false;
                }
                if (!running) break;
                const bool changed = mpv_render_context_update(renderer) & MPV_RENDER_UPDATE_FRAME;
                const bool resized = width != geometry.width || height != geometry.height;
                IOSurfaceRef presented = NULL;
                if (geometry.visible && (changed || redraw || resized)) {
                    if (!surface || resized) {
                        if (surface) CFRelease(surface);
                        width = geometry.width; height = geometry.height;
                        surface = target(context, width, height, &texture, framebuffer);
                    }
                    mpv_opengl_fbo output = { .fbo = (int)framebuffer, .w = (int)width, .h = (int)height, .internal_format = GL_RGBA8 };
                    // IOSurface row zero and Metal UV zero both describe the top row.
                    int flip = 0;
                    mpv_render_param parameters[] = {{ MPV_RENDER_PARAM_OPENGL_FBO, &output }, { MPV_RENDER_PARAM_FLIP_Y, &flip }, {0}};
                    check(mpv_render_context_render(renderer, parameters));
                    // Fence OpenGL writes before another API/process samples the surface.
                    // This waits for GPU completion; it does not read or copy frame pixels.
                    glFinish();
                    presented = surface;
                    redraw = false;
                    frames++;
                } else if (changed) {
                    int skip = 1;
                    mpv_render_param parameters[] = {{ MPV_RENDER_PARAM_SKIP_RENDERING, &skip }, {0}};
                    check(mpv_render_context_render(renderer, parameters));
                    redraw = true;
                }
                const bool wasVisible = geometry.visible;
                geometry = exchange(host, reply, presented, ++sequence);
                if (geometry.visible && !wasVisible) redraw = true;
                if (presented) mpv_render_context_report_swap(renderer);
                if (presented && frames % 300 == 0) {
                    struct rusage usage = {0}; getrusage(RUSAGE_SELF, &usage);
                    fprintf(stderr, "Vroom GPU presentation: frames=%llu elapsed=%.2f cpu=%.2f size=%ux%u\n", frames,
                        CFAbsoluteTimeGetCurrent() - started,
                        usage.ru_utime.tv_sec + usage.ru_stime.tv_sec + (usage.ru_utime.tv_usec + usage.ru_stime.tv_usec) / 1e6,
                        width, height);
                }
            }
        }
        mpv_render_context_set_update_callback(renderer, NULL, NULL);
        mpv_set_wakeup_callback(mpv, NULL, NULL);
        mpv_render_context_free(renderer);
        glDeleteTextures(1, &texture); glDeleteFramebuffers(1, &framebuffer);
        if (surface) CFRelease(surface);
        CGLSetCurrentContext(NULL); CGLReleaseContext(context);
        mpv_terminate_destroy(mpv);
        mach_port_mod_refs(mach_task_self(), reply, MACH_PORT_RIGHT_RECEIVE, -1);
        mach_port_deallocate(mach_task_self(), host);
    }
    return 0;
}
