// Private host/decoder transport. No media paths, commands or annotations cross it.
// IOSurface rights, not pixels, travel in the Mach message. A frame is writable
// again only after the presenter has completed its Metal command buffer.
#pragma once
#include <mach/mach.h>
#include <stdint.h>

enum { VR_VIDEO_VERSION = 1, VR_VIDEO_MESSAGE = 0x565246, VR_VIDEO_REPLY = 0x565241 };
typedef struct {
    mach_msg_header_t header;
    mach_msg_body_t body;
    mach_msg_port_descriptor_t surface;
    uint32_t version;
    uint32_t sequence;
} VRVideoFrame;

typedef struct {
    mach_msg_header_t header;
    uint32_t version;
    uint32_t sequence;
    uint32_t width;
    uint32_t height;
    uint32_t visible;
} VRVideoReply;
