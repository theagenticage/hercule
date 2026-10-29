/**
 * The message that closes a thread's transcript or an assistant's Conversation
 * when the controller sent a row this app cannot decode, usually because the
 * controller is newer than the app. The live stream has stopped for good, so
 * what follows the last row drawn can only be seen after updating the app.
 */
export const UNREADABLE_STREAM_MESSAGE =
  "The rest of this thread can't be shown because this app is out of date. Update the app to see it.";
