using Foundation;
using Microsoft.Maui;
using UIKit;

namespace Vroom.App;

[Register("SceneDelegate")]
public class SceneDelegate : MauiUISceneDelegate
{
    private static UISceneSession? workspace;
    private static readonly HashSet<Window> pendingDialogs = [];

    internal static void ExpectDialog(Window window) => pendingDialogs.Add(window);

    internal static void ForgetDialog(Window window) => pendingDialogs.Remove(window);

    public override void WillConnect(UIScene scene, UISceneSession session, UISceneConnectionOptions options)
    {
        // MAUI OpenWindow supplies a user activity for each live dialog request.
        // Restored scenes have no live opener/portal; restore just one workspace
        // instead of attaching the same page to several windows after a crash.
        var requestedWindow = options.UserActivities.Count > 0 && pendingDialogs.Count > 0;
        if (requestedWindow)
            pendingDialogs.Remove(pendingDialogs.First());
        if (!requestedWindow && workspace is not null)
        {
            UIApplication.SharedApplication.RequestSceneSessionDestruction(session, null, null);
            using var request = UISceneSessionActivationRequest.Create(workspace);
            UIApplication.SharedApplication.ActivateSceneSession(request, null);
            return;
        }
        base.WillConnect(scene, session, options);
        if (!requestedWindow)
            workspace = session;
    }

    public override void DidDisconnect(UIScene scene)
    {
        if (workspace?.PersistentIdentifier == scene.Session.PersistentIdentifier)
            workspace = null;
        base.DidDisconnect(scene);
    }
}
