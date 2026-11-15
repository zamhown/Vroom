// A small macOS bundle exposes public AppKit window actions to Catalyst.
// No decoder, media state or application UI is hosted here.
#import <AppKit/AppKit.h>
static __weak NSWindow *mainWindow;
typedef void (*VRCloseRequest)(uint64_t);

@interface VRDialogDelegate : NSObject <NSWindowDelegate>
@property(weak) NSWindow *window;
@property(weak) NSWindow *owner;
@property(strong) id<NSWindowDelegate> previous;
@property uint64_t token;
@property VRCloseRequest closeRequest;
@property BOOL changingFrame;
@property BOOL userPositioned;
@end

@implementation VRDialogDelegate
- (BOOL)respondsToSelector:(SEL)selector {
    return [super respondsToSelector:selector] || [self.previous respondsToSelector:selector];
}
- (id)forwardingTargetForSelector:(SEL)selector {
    if ([self.previous respondsToSelector:selector]) return self.previous;
    return [super forwardingTargetForSelector:selector];
}
- (BOOL)windowShouldClose:(NSWindow *)sender {
    (void)sender;
    // React owns cancellation and busy-state guards. Its eventual window.close()
    // detaches this adapter before MAUI closes the scene.
    if (self.closeRequest) self.closeRequest(self.token);
    return NO;
}
- (void)windowDidMove:(NSNotification *)notification {
    if (!self.changingFrame) self.userPositioned = YES;
    if ([self.previous respondsToSelector:_cmd]) [self.previous windowDidMove:notification];
}
- (void)windowDidResize:(NSNotification *)notification {
    if (!self.changingFrame) self.userPositioned = YES;
    if ([self.previous respondsToSelector:_cmd]) [self.previous windowDidResize:notification];
}
@end

static NSMutableDictionary<NSNumber *, VRDialogDelegate *> *dialogs;

static NSRect fittedFrame(NSRect frame, NSRect anchor, NSRect available, BOOL center) {
    frame.size.width = MIN(frame.size.width, available.size.width);
    frame.size.height = MIN(frame.size.height, available.size.height);
    if (center) frame.origin = NSMakePoint(NSMidX(anchor) - frame.size.width / 2, NSMidY(anchor) - frame.size.height / 2);
    frame.origin.x = MAX(NSMinX(available), MIN(frame.origin.x, NSMaxX(available) - frame.size.width));
    frame.origin.y = MAX(NSMinY(available), MIN(frame.origin.y, NSMaxY(available) - frame.size.height));
    return frame;
}

int vroom_window_center(const char *title) {
    NSCAssert(NSThread.isMainThread, @"Window placement belongs to the UI thread");
    static dispatch_once_t diagnosticOnce;
    dispatch_once(&diagnosticOnce, ^{
        if (getenv("VROOM_WINDOW_DIAGNOSTICS"))
            [NSNotificationCenter.defaultCenter addObserverForName:NSWindowDidChangeOcclusionStateNotification object:nil queue:nil usingBlock:^(NSNotification *notification) {
                NSWindow *changed = notification.object;
                NSLog(@"Vroom visibility: title=%@ visible=%d activeSpace=%d occluded=%d", changed.title, changed.visible,
                    changed.onActiveSpace, !(changed.occlusionState & NSWindowOcclusionStateVisible));
            }];
    });
    NSWindow *window = nil;
    for (NSWindow *candidate in NSApp.windows)
        if ([candidate.title isEqualToString:@(title)]) { window = candidate; break; }
    if (!window) return 0;
    for (VRDialogDelegate *existing in dialogs.allValues)
        if (existing.window == window) return 0;
    mainWindow = window;
    if (!(window.styleMask & NSWindowStyleMaskFullScreen)) {
        const NSRect available = (window.screen ?: NSScreen.mainScreen).visibleFrame;
        [window setFrame:fittedFrame(window.frame, available, available, YES) display:YES];
        if (getenv("VROOM_WINDOW_DIAGNOSTICS"))
            NSLog(@"Vroom main placement: frame=%@ available=%@", NSStringFromRect(window.frame), NSStringFromRect(available));
    }
    return 1;
}

void vroom_window_attach(void) {
    if (!mainWindow) mainWindow = NSApp.mainWindow ?: NSApp.keyWindow;
    if (!mainWindow)
        for (NSWindow *window in NSApp.windows)
            if ([window.title isEqualToString:@"Vroom"]) { mainWindow = window; break; }
}
int vroom_window_fullscreen(int requested) {
    vroom_window_attach();
    if (!mainWindow) return 0;
    const BOOL current = (mainWindow.styleMask & NSWindowStyleMaskFullScreen) != 0;
    const BOOL next = requested < 0 ? !current : requested != 0;
    if (next != current) [mainWindow toggleFullScreen:nil];
    return next;
}
int vroom_window_is_fullscreen(void) {
    return mainWindow && (mainWindow.styleMask & NSWindowStyleMaskFullScreen) != 0;
}

int vroom_dialog_attach(uint64_t token, uint64_t ownerToken, const char *title, VRCloseRequest closeRequest) {
    NSCAssert(NSThread.isMainThread, @"Window ownership belongs to the UI thread");
    if (dialogs[@(token)]) return 1;
    vroom_window_attach();
    NSWindow *owner = ownerToken ? dialogs[@(ownerToken)].window : mainWindow;
    NSWindow *window = nil;
    for (NSWindow *candidate in NSApp.windows) {
        if (candidate == owner || ![candidate.title isEqualToString:@(title)]) continue;
        BOOL attached = NO;
        for (VRDialogDelegate *existing in dialogs.allValues)
            if (existing.window == candidate) attached = YES;
        if (!attached) { window = candidate; break; }
    }
    if (!owner || !window) return 0;
    if (!dialogs) dialogs = [NSMutableDictionary new];
    VRDialogDelegate *delegate = [VRDialogDelegate new];
    delegate.window = window;
    delegate.owner = owner;
    delegate.previous = window.delegate;
    delegate.token = token;
    delegate.closeRequest = closeRequest;
    dialogs[@(token)] = delegate;
    // Catalyst owns the scene hierarchy. Do not reparent its NSWindows: doing so
    // can leave the owner scene inactive after a document picker is dismissed.
    window.restorable = NO;
    window.delegate = delegate;
    delegate.changingFrame = YES;
    const NSRect available = (owner.screen ?: NSScreen.mainScreen).visibleFrame;
    [window setFrame:fittedFrame(window.frame, owner.frame, available, YES) display:YES];
    delegate.changingFrame = NO;
    return 1;
}

double vroom_dialog_resize(uint64_t token, double width, double height) {
    VRDialogDelegate *delegate = dialogs[@(token)];
    NSWindow *window = delegate.window;
    if (!window || !delegate.owner || !isfinite(width) || !isfinite(height) || width <= 0 || height <= 0) return 0;
    const NSRect available = (window.screen ?: delegate.owner.screen ?: NSScreen.mainScreen).visibleFrame;
    NSRect frame = window.frame;
    // After a user's drag/resize, auto-fit keeps their top edge and position.
    // Before that, content measurement and nested forms stay centered on the owner.
    frame.origin.y = NSMaxY(frame) - MIN(height, available.size.height);
    frame.size = NSMakeSize(width, height);
    frame = fittedFrame(frame, delegate.owner.frame, available, !delegate.userPositioned);
    if (!NSEqualRects(window.frame, frame)) {
        delegate.changingFrame = YES;
        [window setFrame:frame display:YES];
        delegate.changingFrame = NO;
        if (getenv("VROOM_WINDOW_DIAGNOSTICS"))
            NSLog(@"Vroom dialog placement: frame=%@ owner=%@ available=%@ userPositioned=%d", NSStringFromRect(window.frame),
                NSStringFromRect(delegate.owner.frame), NSStringFromRect(available), delegate.userPositioned);
    }
    return available.size.height;
}

void vroom_dialog_detach(uint64_t token) {
    VRDialogDelegate *delegate = dialogs[@(token)];
    NSWindow *window = delegate.window;
    if (window.delegate == delegate) window.delegate = delegate.previous;
    [dialogs removeObjectForKey:@(token)];
}
