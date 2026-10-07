// Every icon the v1 desktop pages draw, for the specimen sheet and the tests,
// which need all of them. The app imports each icon from its own module
// instead, and eslint refuses an import of this file anywhere else.
//
// The bundler decides which chunk a module ships in from the imports that
// reach it, not from what is used. An icon reached through this file is
// reached from the first screen's code, so it would ship with the first
// screen even when only a dialog loaded later draws it. An icon imported
// from its own module ships with the code that draws it.
//
// Every coordinate is copied from the Bureau book's crew.js as the same
// string, so the markup matches the book's attribute for attribute. The book
// fills small dots (radius .4 to .6) at runtime; here the fill is written on
// the dot itself.
export { IconFrame, type IconProps } from "./icon-frame";
export { BoundIcon } from "./bound";
export { BranchIcon } from "./branch";
export { ChatIcon } from "./chat";
export { CheckIcon } from "./check";
export { ChevronRightIcon } from "./chevron-right";
export { ClockIcon } from "./clock";
export { CloseIcon } from "./close";
export { ComposeIcon } from "./compose";
export { ConnectionsIcon } from "./connections";
export { CpuIcon } from "./cpu";
export { CrewIcon } from "./crew";
export { EditorIcon } from "./editor";
export { ExternalIcon } from "./external";
export { EyeIcon } from "./eye";
export { FileIcon } from "./file";
export { FleetIcon } from "./fleet";
export { GlobeIcon } from "./globe";
export { HeartIcon } from "./heart";
export { IdIcon } from "./id";
export { IntakeIcon } from "./intake";
export { KeyIcon } from "./key";
export { LaptopIcon } from "./laptop";
export { ListIcon } from "./list";
export { MicIcon } from "./mic";
export { MoreIcon } from "./more";
export { OfficeIcon } from "./office";
export { PaletteIcon } from "./palette";
export { PauseIcon } from "./pause";
export { PlusIcon } from "./plus";
export { PuzzleIcon } from "./puzzle";
export { QuestionIcon } from "./question";
export { SearchIcon } from "./search";
export { SendIcon } from "./send";
export { ServerIcon } from "./server";
export { ShieldIcon } from "./shield";
export { SidebarIcon } from "./sidebar";
export { SlidersIcon } from "./sliders";
export { SparkleIcon } from "./sparkle";
export { StopIcon } from "./stop";
export { SystemIcon } from "./system";
export { TasksIcon } from "./tasks";
export { TerminalIcon } from "./terminal";
export { ThreadsIcon } from "./threads";
export { UndoIcon } from "./undo";
export { UserIcon } from "./user";
export { WorkspaceIcon } from "./workspace";
