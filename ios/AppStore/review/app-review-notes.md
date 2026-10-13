# App Review notes — Juggle Tracker

Paste the section below into App Store Connect › your version › **App Review Information › Notes**,
and attach `juggle-tracker-review-demo.mp4` under **Attachment**.

---

Juggle Tracker counts juggling throws from the camera, on the device. There is no account, sign-in or network use.

You don't need to juggle to test it. We've attached a 30-second video of someone juggling three balls (juggle-tracker-review-demo.mp4).

To test with the video:
1. Save the attached video to the device (Photos or Files).
2. Open Juggle Tracker and tap the paperclip button next to "Start session".
3. Choose "Video from Photos" or "Video from Files" and pick the video.
4. The video plays in the app. The large number counts each throw at the top of the ball's arc, and orange lines show the balls being tracked. A run ends when the juggler pauses or drops.
5. When the video ends, the session summary shows the best run, run count, total throws and timing. The session then appears in the history on the home screen. Swipe left on it, or open it and tap the trash icon, to delete it.

To test with the camera: tap "Start session", allow camera access, prop the device up facing a person, and toss a ball or two in the air. The ball model is trained on juggling beanbags, so small, round, colourful balls work best.

Privacy: all video is analysed on the device by a bundled Core ML model and is never stored or sent anywhere. The app collects no data. Settings › "Export all data (JSON)" lets the user export their own session history through the share sheet.
