// A separate supervisor owns each decoder/encoder process group. kqueue observes
// the actual parent process (no PID polling), including SIGKILL and crash exits.
// This is a macOS executable, not a Catalyst library; it never loads into the UI.
#include <sys/event.h>
#include <sys/wait.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

static volatile sig_atomic_t stopping;
static void stop(int signal_number) { stopping = signal_number; }

int main(int argc, char **argv) {
    if (argc < 2) return 64;
    const pid_t owner = getppid();
    const int queue = kqueue();
    if (queue < 0 || owner <= 1) return 70;
    struct kevent event;
    EV_SET(&event, owner, EVFILT_PROC, EV_ADD | EV_ENABLE, NOTE_EXIT, 0, NULL);
    if (kevent(queue, &event, 1, NULL, 0, NULL) < 0 || getppid() != owner) return 70;
    struct sigaction action = {0};
    action.sa_handler = stop;
    sigemptyset(&action.sa_mask);
    sigaction(SIGTERM, &action, NULL);
    sigaction(SIGINT, &action, NULL);
    sigaction(SIGHUP, &action, NULL);
    const pid_t child = fork();
    if (child < 0) return 71;
    if (child == 0) {
        close(queue);
        setpgid(0, 0);
        signal(SIGTERM, SIG_DFL);
        signal(SIGINT, SIG_DFL);
        signal(SIGHUP, SIG_DFL);
        execvp(argv[1], argv + 1);
        perror("vroom-process-host: exec");
        _exit(127);
    }
    setpgid(child, child);
    EV_SET(&event, child, EVFILT_PROC, EV_ADD | EV_ENABLE, NOTE_EXIT, 0, NULL);
    // ESRCH is possible when a short-lived command exits before registration.
    if (kevent(queue, &event, 1, NULL, 0, NULL) < 0 && errno != ESRCH) stopping = SIGTERM;
    int status = 0;
    while (!stopping) {
        const pid_t result = waitpid(child, &status, WNOHANG);
        if (result == child) break;
        if (result < 0 && errno != EINTR) { stopping = SIGTERM; break; }
        const struct timespec timeout = {1, 0};
        const int count = kevent(queue, NULL, 0, &event, 1, &timeout);
        if (count > 0 && event.ident == (uintptr_t)owner) stopping = SIGTERM;
        if (count < 0 && errno != EINTR) stopping = SIGTERM;
    }
    // Also reap descendants after the main tool exits. They cannot outlive the session.
    kill(-child, SIGKILL);
    if (stopping) while (waitpid(child, &status, 0) < 0 && errno == EINTR) {}
    close(queue);
    if (stopping) return 128 + stopping;
    return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}
