// Main executable of Juggle Break Camera.app: gets camera access, then runs the helper with the
// venv's Python. The app exists so macOS has an app with a camera usage description to ask about;
// exec keeps this process (and so the app) as the one the camera permission belongs to.
#import <AVFoundation/AVFoundation.h>
#include <libgen.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

static void emit(const char *type, const char *message) {
  printf("{\"type\":\"%s\",\"message\":\"%s\"}\n", type, message);
  fflush(stdout);
}

static BOOL cameraAllowed(void) {
  AVAuthorizationStatus status = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeVideo];
  if (status == AVAuthorizationStatusAuthorized) return YES;
  if (status != AVAuthorizationStatusNotDetermined) return NO;
  emit("waiting", "Waiting for camera permission. Allow \\\"Juggle Break Camera\\\" in the macOS prompt.");
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  __block BOOL granted = NO;
  [AVCaptureDevice requestAccessForMediaType:AVMediaTypeVideo completionHandler:^(BOOL ok) {
    granted = ok;
    dispatch_semaphore_signal(done);
  }];
  dispatch_semaphore_wait(done, DISPATCH_TIME_FOREVER);
  return granted;
}

int main(int argc, char **argv) {
  char exe[PATH_MAX], real[PATH_MAX], python[PATH_MAX], script[PATH_MAX];
  uint32_t size = sizeof exe;
  if (_NSGetExecutablePath(exe, &size) != 0 || !realpath(exe, real)) return 1;
  // <root>/Juggle Break Camera.app/Contents/MacOS/launcher -> <root>
  char *root = real;
  for (int i = 0; i < 4; i++) root = dirname(root);
  snprintf(python, sizeof python, "%s/.venv/bin/python", root);
  snprintf(script, sizeof script, "%s/helper/juggle.py", root);

  @autoreleasepool {
    if (!cameraAllowed()) {
      emit("error", "Camera access is off for Juggle Break Camera. Turn it on in System Settings > "
                    "Privacy & Security > Camera, then send another prompt.");
      return 1;
    }
  }

  char **args = calloc(argc + 2, sizeof *args);
  args[0] = python;
  args[1] = script;
  for (int i = 1; i < argc; i++) args[i + 1] = argv[i];
  execv(python, args);
  perror("juggle-break: could not start python");
  return 1;
}
