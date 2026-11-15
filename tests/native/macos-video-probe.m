// Test-only receiver: CPU sampling verifies that changing pixels really cross
// the process boundary. Production uses Metal and never reads surface pixels.
#import <Foundation/Foundation.h>
#import <IOSurface/IOSurface.h>
#include <servers/bootstrap.h>
#include "../../src/Vroom.App/Platforms/MacCatalyst/video-wire.h"

int main(void) {
    @autoreleasepool {
        mach_port_t port;
        if (mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE, &port) != KERN_SUCCESS) return 1;
        if (mach_port_insert_right(mach_task_self(), port, port, MACH_MSG_TYPE_MAKE_SEND) != KERN_SUCCESS) return 2;
        char name[128];
        snprintf(name, sizeof(name), "app.vroom.video.%d.%u", getpid(), arc4random());
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
        if (bootstrap_register(bootstrap_port, name, port) != KERN_SUCCESS) return 3;
#pragma clang diagnostic pop
        printf("{\"service\":\"%s\"}\n", name); fflush(stdout);
        unsigned frames = 0;
        for (;;) {
            struct { VRVideoFrame value; mach_msg_max_trailer_t trailer; } request = {0};
            if (mach_msg(&request.value.header, MACH_RCV_MSG | MACH_RCV_TIMEOUT, 0, sizeof(request), port, 20000, MACH_PORT_NULL) != KERN_SUCCESS) return 4;
            if (request.value.header.msgh_id != VR_VIDEO_MESSAGE || request.value.version != VR_VIDEO_VERSION) return 5;
            IOSurfaceRef surface = request.value.surface.name ? IOSurfaceLookupFromMachPort(request.value.surface.name) : NULL;
            if (request.value.surface.name) mach_port_deallocate(mach_task_self(), request.value.surface.name);
            if (surface) {
                frames++;
                IOSurfaceLock(surface, kIOSurfaceLockReadOnly, NULL);
                const uint8_t *pixels = IOSurfaceGetBaseAddress(surface);
                const size_t count = IOSurfaceGetAllocSize(surface);
                uint32_t hash = 2166136261;
                for (size_t i = 0; i < count; i += 97) hash = (hash ^ pixels[i]) * 16777619;
                const size_t stride = IOSurfaceGetBytesPerRow(surface);
                const uint8_t *top = pixels + stride * 5 + 5 * 4;
                const uint8_t *bottom = pixels + stride * (IOSurfaceGetHeight(surface) - 6) + 5 * 4;
                const bool upright = top[2] > 180 && top[0] < 80 && bottom[0] > 180 && bottom[2] < 80;
                IOSurfaceUnlock(surface, kIOSurfaceLockReadOnly, NULL);
                printf("{\"frame\":%u,\"hash\":%u,\"width\":%zu,\"height\":%zu,\"upright\":%s}\n", frames, hash, IOSurfaceGetWidth(surface), IOSurfaceGetHeight(surface), upright ? "true" : "false");
                fflush(stdout);
                CFRelease(surface);
            }
            VRVideoReply response = {0};
            response.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_MOVE_SEND_ONCE, 0);
            response.header.msgh_size = sizeof(response);
            response.header.msgh_remote_port = request.value.header.msgh_remote_port;
            response.header.msgh_id = VR_VIDEO_REPLY;
            response.version = VR_VIDEO_VERSION;
            response.sequence = request.value.sequence;
            response.width = frames < 10 ? 320 : 640;
            response.height = frames < 10 ? 180 : 360;
            response.visible = 1;
            if (mach_msg(&response.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, sizeof(response), 0, MACH_PORT_NULL, 1000, MACH_PORT_NULL) != KERN_SUCCESS) return 6;
        }
    }
}
