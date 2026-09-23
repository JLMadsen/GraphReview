// Barrel for lib/ai. See README.md.
export { chatCompletion } from "./client";
export type { ChatCompletionOptions } from "./client";

export { extractJson } from "./parse";

export {
  estimateTokens,
  estimateMessagesTokens,
  truncateMessagesToBudget,
  CHARS_PER_TOKEN,
  DEFAULT_TOKEN_BUDGET,
} from "./budget";

export { AiClientError } from "./errors";

export { reviewComponentChange, pingProvider } from "./review";
export type {
  ReviewIntent,
  ReviewComponentContext,
  ReviewFileDiff,
  ReviewInput,
  IntentMatch,
  ReviewFinding,
  ReviewResult,
  ReviewOptions,
  ReviewNeighbor,
  ReviewRelatedFile,
  ReviewRelatedContext,
} from "./review";

export {
  DEFAULT_REVIEW_EFFORT,
  REVIEW_EFFORTS,
  REVIEW_EFFORT_SETTINGS,
  isReviewEffort,
} from "./effort";
export type { ReviewEffort, ReviewEffortSettings } from "./effort";

export {
  DEFAULT_DESCRIPTION_BATCH,
  DESCRIBE_TASK_MARKER,
  DOMAIN_TASK_MARKER,
  FALLBACK_DOMAIN_NAME,
  MAX_DOMAINS,
  buildDescribeSystemPrompt,
  buildDomainSystemPrompt,
  describeModules,
  labelComponents,
  labelDomains,
} from "./label";
export type {
  LabelDomain,
  LabelInput,
  LabelModuleDescription,
  LabelModuleInput,
  LabelOptions,
  LabelPhase,
  LabelProgressEvent,
  LabelResult,
  PhaseResult,
} from "./label";

export { buildSystemPrompt, buildUserMessage } from "./prompts";
export type { UserMessageOptions } from "./prompts";

export type {
  AiProviderConfig,
  ChatMessage,
  ChatRole,
  ChatCompletionResult,
  TokenUsage,
} from "./types";
