import {
  LoopNodeView,
  MapNodeView,
  MergeNodeView,
  PauseNodeView,
  RouterNodeView,
  UserInputNodeView,
} from "./ControlFlowNodeViews.js";
import { PromptNodeView } from "./PromptNodeView.js";

export const nodeTypes = {
  prompt: PromptNodeView,
  router: RouterNodeView,
  merge: MergeNodeView,
  pause: PauseNodeView,
  userInput: UserInputNodeView,
  loop: LoopNodeView,
  map: MapNodeView,
};
