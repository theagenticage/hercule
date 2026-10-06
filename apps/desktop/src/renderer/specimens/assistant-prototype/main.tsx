/**
 * PROTOTYPE (#448): an assistant's Conversation on the desktop app's real
 * shell, in three variants. Run it with
 *
 *   cd apps/desktop && npx vite --config vite.renderer.config.ts --port 5199
 *
 * and open /specimens/assistant-prototype/index.html. The URL keeps
 * `?variant=A|B|C`, `?state=streaming|idle|approval|asleep|unreachable` and
 * `?theme=`.
 */
import "../fixed-clock";
import "../../screens/thread/thread.css";
import "../../screens/thread/thread-header.css";
import "../../screens/thread/composer.css";
import "../../screens/thread/dock.css";
import "./prototype.css";
import "./prototype-state";
import { FIX_THREAD, THREAD_PAGE_RECORDS } from "../thread-fixture";
import { mountAssistantPrototype } from "../shell-page";
import { AssistantScreen } from "./assistant-screen";
import { AssistantsSection } from "./assistants-section";
import { ADA } from "./fixture";
import { Switcher } from "./switcher";

await mountAssistantPrototype(
  THREAD_PAGE_RECORDS,
  FIX_THREAD,
  { screen: AssistantScreen, section: <AssistantsSection />, overlay: <Switcher /> },
  `/assistants/${ADA.id}`,
);
