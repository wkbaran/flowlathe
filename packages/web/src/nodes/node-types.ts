import {
  GateNodeView,
  LoopNodeView,
  MapNodeView,
  MergeNodeView,
  PauseNodeView,
  RouterNodeView,
  UserInputNodeView,
} from "./ControlFlowNodeViews.js";
import { PromptNodeView } from "./PromptNodeView.js";
import { FetchNodeView, SearchNodeView } from "./SearchFetchNodeViews.js";

export const nodeTypes = {
  prompt: PromptNodeView,
  router: RouterNodeView,
  merge: MergeNodeView,
  pause: PauseNodeView,
  userInput: UserInputNodeView,
  loop: LoopNodeView,
  map: MapNodeView,
  gate: GateNodeView,
  search: SearchNodeView,
  fetch: FetchNodeView,
};
