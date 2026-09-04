export const TRANSCRIPT_REDACTED = "[REDACTED]";
export const TRANSCRIPT_REASONING_OMITTED = "[REASONING OMITTED]";
export const TRANSCRIPT_TRUNCATED = "[TRUNCATED]";

const TRANSCRIPT_CIRCULAR = "[CIRCULAR]";
const TRANSCRIPT_UNSERIALIZABLE = "[UNSERIALIZABLE]";
const MAX_IDENTIFIER_CHARS = 256;

export interface TranscriptLimits {
  maxReviewersPerReview: number;
  maxItemsPerReviewer: number;
  maxRunItems: number;
  maxTextChars: number;
  maxValueChars: number;
  maxDepth: number;
  maxCollectionEntries: number;
}

export const DEFAULT_TRANSCRIPT_LIMITS: Readonly<TranscriptLimits> =
  Object.freeze({
    maxReviewersPerReview: 4,
    maxItemsPerReviewer: 250,
    maxRunItems: 50,
    maxTextChars: 8_000,
    maxValueChars: 12_000,
    maxDepth: 8,
    maxCollectionEntries: 100,
  });

export type ReviewTranscriptStatus =
  "started" | "running" | "complete" | "failed" | "cancelled";

export type ReviewerTranscriptRole = "lead" | "specialist";
export type ReviewerTranscriptStage = "review" | "adjudication";

export interface StartReviewInput {
  runId?: string;
  scopeLabel: string;
  scopeSummary: string;
}

export interface ReviewerTranscriptDescriptor {
  id: string;
  role: ReviewerTranscriptRole;
  stage: ReviewerTranscriptStage;
  model: string;
  thinkingLevel: string;
  specialty?: string;
}

interface ReviewerTranscriptItemBase {
  id: number;
  at: number;
  stage: ReviewerTranscriptStage;
}

export type ReviewerTranscriptItem =
  | (ReviewerTranscriptItemBase & { kind: "prompt"; text: string })
  | (ReviewerTranscriptItemBase & { kind: "assistant"; text: string })
  | (ReviewerTranscriptItemBase & {
      kind: "tool_call";
      toolName: string;
      toolCallId?: string;
      arguments: string;
    })
  | (ReviewerTranscriptItemBase & {
      kind: "tool_result";
      toolName: string;
      toolCallId?: string;
      isError: boolean;
      summary: string;
    })
  | (ReviewerTranscriptItemBase & { kind: "final_review"; review: string })
  | (ReviewerTranscriptItemBase & { kind: "error"; message: string })
  | (ReviewerTranscriptItemBase & { kind: "note"; text: string })
  | (ReviewerTranscriptItemBase & {
      kind: "status";
      status: string;
      text: string;
    });

type ReviewerTranscriptInputStage = { stage?: ReviewerTranscriptStage };

export type ReviewerTranscriptInput = ReviewerTranscriptInputStage &
  (
    | { kind: "prompt"; text: unknown }
    | { kind: "assistant"; text: unknown; append?: boolean }
    | {
        kind: "tool_call";
        toolName: unknown;
        toolCallId?: unknown;
        arguments: unknown;
      }
    | {
        kind: "tool_result";
        toolName: unknown;
        toolCallId?: unknown;
        isError?: boolean;
        result: unknown;
      }
    | { kind: "final_review"; review: unknown }
    | { kind: "error"; error: unknown }
    | { kind: "note"; text: unknown }
    | { kind: "status"; status: unknown; text?: unknown }
  );

export interface ReviewTranscriptRunItem {
  id: number;
  at: number;
  kind: "note" | "status";
  text: string;
  status?: string;
}

export type ReviewTranscriptRunInput =
  | { kind: "note"; text: unknown }
  | { kind: "status"; status: unknown; text?: unknown };

export interface ReviewerTranscript {
  descriptor: ReviewerTranscriptDescriptor;
  status: ReviewTranscriptStatus;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  droppedItems: number;
  items: ReviewerTranscriptItem[];
}

export interface ReviewTranscriptSnapshot {
  runId: string;
  scopeLabel: string;
  scopeSummary: string;
  status: ReviewTranscriptStatus;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  droppedItems: number;
  items: ReviewTranscriptRunItem[];
  reviewers: ReviewerTranscript[];
}

export interface TranscriptChange {
  runId: string;
  reviewerId?: string;
  snapshot: ReviewTranscriptSnapshot;
}

export type TranscriptListener = (change: TranscriptChange) => void;

export interface SanitizeTranscriptOptions {
  maxTextChars?: number;
  maxDepth?: number;
  maxCollectionEntries?: number;
}

export type SafeTranscriptValue =
  | null
  | boolean
  | number
  | string
  | SafeTranscriptValue[]
  | { [key: string]: SafeTranscriptValue };

interface MutableReviewerTranscript extends ReviewerTranscript {
  nextItemId: number;
}

interface MutableReviewTranscript {
  runId: string;
  scopeLabel: string;
  scopeSummary: string;
  status: ReviewTranscriptStatus;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  droppedItems: number;
  items: ReviewTranscriptRunItem[];
  nextItemId: number;
  reviewers: Map<string, MutableReviewerTranscript>;
}

const AUTH_SCHEME_PATTERN = /\b(Bearer|Basic)\s+[^\s"'`,;]+/gi;
const LABELED_SECRET_PATTERN =
  /(^|[^A-Za-z0-9_])(["']?)([A-Za-z_][A-Za-z0-9_.-]*)\2(\s*[:=]\s*)(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s,;&]+)/gm;
const SECRET_VALUE_PATTERNS = [
  /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AIza[A-Za-z0-9_-]{12,})\b/g,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
  /\b(?:AKIA|ASIA|A3T[A-Z0-9])[A-Z0-9]{16}\b/g,
  /\bya29\.[A-Za-z0-9_-]{10,}\b/g,
];

function normalizeKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function isSecretKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return (
    /token$/.test(normalized) ||
    // Opaque access credentials such as access_key / aws_access_key_id.
    /accesskey(?:id)?$/.test(normalized) ||
    /(?:password|passwd|pwd|secret|secretkey|secretaccesskey|authorization|proxyauthorization|cookie|setcookie|privatekey|credentials?)$/.test(
      normalized,
    ) ||
    /apikey$/.test(normalized)
  );
}

function isReasoningKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return (
    normalized === "thinking" ||
    normalized === "thinkingdelta" ||
    normalized === "reasoning" ||
    normalized === "reasoningcontent" ||
    normalized === "chainofthought" ||
    normalized === "cot"
  );
}

function assertTextLimit(maxChars: number): void {
  if (
    !Number.isSafeInteger(maxChars) ||
    maxChars < TRANSCRIPT_TRUNCATED.length
  ) {
    throw new RangeError(
      `Transcript text limits must be integers >= ${TRANSCRIPT_TRUNCATED.length}`,
    );
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function validateTimestamp(at: number): void {
  if (!Number.isFinite(at)) throw new RangeError("Timestamp must be finite");
}

function validateStage(stage: unknown): ReviewerTranscriptStage {
  if (stage === "review" || stage === "adjudication") return stage;
  throw new Error(`Unknown reviewer transcript stage: ${String(stage)}`);
}

export function truncateTranscriptText(
  value: string,
  maxChars: number,
): string {
  assertTextLimit(maxChars);
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - TRANSCRIPT_TRUNCATED.length)}${TRANSCRIPT_TRUNCATED}`;
}

export function redactTranscriptText(value: unknown): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : String(value ?? "");
  } catch {
    return TRANSCRIPT_UNSERIALIZABLE;
  }
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ");
  AUTH_SCHEME_PATTERN.lastIndex = 0;
  text = text.replace(
    AUTH_SCHEME_PATTERN,
    (_match, scheme: string) => `${scheme} ${TRANSCRIPT_REDACTED}`,
  );
  LABELED_SECRET_PATTERN.lastIndex = 0;
  text = text.replace(
    LABELED_SECRET_PATTERN,
    (match, prefix: string, quote: string, label: string, separator: string) =>
      isSecretKey(label)
        ? `${prefix}${quote}${label}${quote}${separator}${TRANSCRIPT_REDACTED}`
        : match,
  );
  for (const pattern of SECRET_VALUE_PATTERNS) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, TRANSCRIPT_REDACTED);
  }
  return text;
}

function sanitizeValue(
  value: unknown,
  options: Required<SanitizeTranscriptOptions>,
  depth: number,
  ancestors: Set<object>,
): SafeTranscriptValue {
  if (value === null) return null;
  if (typeof value === "string") {
    return truncateTranscriptText(
      redactTranscriptText(value),
      options.maxTextChars,
    );
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "undefined") return "[UNDEFINED]";
  if (typeof value === "symbol" || typeof value === "function") {
    return `[${typeof value === "function" ? "FUNCTION" : "SYMBOL"}]`;
  }
  if (typeof value !== "object") return redactTranscriptText(value);
  if (value instanceof Error) {
    return {
      name: truncateTranscriptText(
        redactTranscriptText(value.name),
        options.maxTextChars,
      ),
      message: truncateTranscriptText(
        redactTranscriptText(value.message),
        options.maxTextChars,
      ),
    };
  }
  if (value instanceof Date) {
    try {
      return value.toISOString();
    } catch {
      return TRANSCRIPT_UNSERIALIZABLE;
    }
  }
  if (ancestors.has(value)) return TRANSCRIPT_CIRCULAR;
  if (depth >= options.maxDepth) return TRANSCRIPT_TRUNCATED;

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const result = value
        .slice(0, options.maxCollectionEntries)
        .map((entry) => sanitizeValue(entry, options, depth + 1, ancestors));
      if (value.length > options.maxCollectionEntries) {
        result.push(TRANSCRIPT_TRUNCATED);
      }
      return result;
    }

    let entries: [string, unknown][];
    try {
      entries = Object.entries(value as Record<string, unknown>);
    } catch {
      return TRANSCRIPT_UNSERIALIZABLE;
    }
    const typeEntry = entries.find(([key]) => key === "type");
    if (
      typeEntry &&
      typeof typeEntry[1] === "string" &&
      ["thinking", "thinking_start", "thinking_delta", "reasoning"].includes(
        typeEntry[1],
      )
    ) {
      return TRANSCRIPT_REASONING_OMITTED;
    }

    const result: { [key: string]: SafeTranscriptValue } = Object.create(null);
    for (const [key, entry] of entries.slice(0, options.maxCollectionEntries)) {
      if (isReasoningKey(key)) {
        result[key] = TRANSCRIPT_REASONING_OMITTED;
      } else if (isSecretKey(key)) {
        result[key] = TRANSCRIPT_REDACTED;
      } else {
        result[key] = sanitizeValue(entry, options, depth + 1, ancestors);
      }
    }
    if (entries.length > options.maxCollectionEntries) {
      result.__truncated__ = TRANSCRIPT_TRUNCATED;
    }
    return result;
  } catch {
    return TRANSCRIPT_UNSERIALIZABLE;
  } finally {
    ancestors.delete(value);
  }
}

export function sanitizeTranscriptValue(
  value: unknown,
  options: SanitizeTranscriptOptions = {},
): SafeTranscriptValue {
  const maxTextChars =
    options.maxTextChars ?? DEFAULT_TRANSCRIPT_LIMITS.maxTextChars;
  const maxDepth = positiveInteger(
    options.maxDepth ?? DEFAULT_TRANSCRIPT_LIMITS.maxDepth,
    "maxDepth",
  );
  const maxCollectionEntries = positiveInteger(
    options.maxCollectionEntries ??
      DEFAULT_TRANSCRIPT_LIMITS.maxCollectionEntries,
    "maxCollectionEntries",
  );
  assertTextLimit(maxTextChars);
  return sanitizeValue(
    value,
    { maxTextChars, maxDepth, maxCollectionEntries },
    0,
    new Set(),
  );
}

export function serializeTranscriptValue(
  value: unknown,
  maxChars = DEFAULT_TRANSCRIPT_LIMITS.maxValueChars,
  options: Omit<SanitizeTranscriptOptions, "maxTextChars"> = {},
): string {
  assertTextLimit(maxChars);
  let serialized: string;
  try {
    serialized = JSON.stringify(
      sanitizeTranscriptValue(value, {
        ...options,
        maxTextChars: maxChars,
      }),
      null,
      2,
    );
  } catch {
    serialized = JSON.stringify(TRANSCRIPT_UNSERIALIZABLE);
  }
  return truncateTranscriptText(serialized, maxChars);
}

export function summarizeToolResult(
  result: unknown,
  maxChars = DEFAULT_TRANSCRIPT_LIMITS.maxValueChars,
): string {
  if (!result || typeof result !== "object") {
    return serializeTranscriptValue(result, maxChars);
  }
  try {
    const record = result as Record<string, unknown>;
    const content = Array.isArray(record.content)
      ? record.content.map((part) => {
          if (!part || typeof part !== "object") return part;
          const typed = part as Record<string, unknown>;
          return typed.type === "text" ? typed.text : typed;
        })
      : record.content;
    return serializeTranscriptValue(
      {
        ...(record.isError === undefined ? {} : { isError: record.isError }),
        ...(content === undefined ? {} : { content }),
        ...(record.details === undefined ? {} : { details: record.details }),
      },
      maxChars,
    );
  } catch {
    return JSON.stringify(TRANSCRIPT_UNSERIALIZABLE);
  }
}

function resolveLimits(
  limits: Partial<TranscriptLimits>,
): Readonly<TranscriptLimits> {
  const resolved: TranscriptLimits = {
    ...DEFAULT_TRANSCRIPT_LIMITS,
    ...limits,
  };
  positiveInteger(resolved.maxReviewersPerReview, "maxReviewersPerReview");
  positiveInteger(resolved.maxItemsPerReviewer, "maxItemsPerReviewer");
  positiveInteger(resolved.maxRunItems, "maxRunItems");
  assertTextLimit(resolved.maxTextChars);
  assertTextLimit(resolved.maxValueChars);
  positiveInteger(resolved.maxDepth, "maxDepth");
  positiveInteger(resolved.maxCollectionEntries, "maxCollectionEntries");
  return Object.freeze(resolved);
}

function normalizeIdentifier(value: unknown, name: string): string {
  const normalized = redactTranscriptText(value).trim();
  if (!normalized) throw new Error(`${name} must not be empty`);
  if (normalized.length > MAX_IDENTIFIER_CHARS) {
    throw new RangeError(
      `${name} must not exceed ${MAX_IDENTIFIER_CHARS} characters`,
    );
  }
  return normalized;
}

function sanitizeText(value: unknown, maxChars: number): string {
  return truncateTranscriptText(redactTranscriptText(value), maxChars);
}

function sanitizeDescriptor(
  descriptor: ReviewerTranscriptDescriptor,
  maxTextChars: number,
): ReviewerTranscriptDescriptor {
  if (descriptor.role !== "lead" && descriptor.role !== "specialist") {
    throw new Error(
      `Unknown reviewer transcript role: ${String(descriptor.role)}`,
    );
  }
  return {
    id: normalizeIdentifier(descriptor.id, "reviewer id"),
    role: descriptor.role,
    stage: validateStage(descriptor.stage),
    model: sanitizeText(descriptor.model, maxTextChars),
    thinkingLevel: sanitizeText(descriptor.thinkingLevel, maxTextChars),
    ...(descriptor.specialty
      ? { specialty: sanitizeText(descriptor.specialty, maxTextChars) }
      : {}),
  };
}

function cloneReview(
  review: MutableReviewTranscript,
): ReviewTranscriptSnapshot {
  return {
    runId: review.runId,
    scopeLabel: review.scopeLabel,
    scopeSummary: review.scopeSummary,
    status: review.status,
    startedAt: review.startedAt,
    updatedAt: review.updatedAt,
    ...(review.completedAt === undefined
      ? {}
      : { completedAt: review.completedAt }),
    droppedItems: review.droppedItems,
    items: review.items.map((item) => ({ ...item })),
    reviewers: [...review.reviewers.values()].map((reviewer) => ({
      descriptor: { ...reviewer.descriptor },
      status: reviewer.status,
      startedAt: reviewer.startedAt,
      updatedAt: reviewer.updatedAt,
      ...(reviewer.completedAt === undefined
        ? {}
        : { completedAt: reviewer.completedAt }),
      droppedItems: reviewer.droppedItems,
      items: reviewer.items.map((item) => ({ ...item })),
    })),
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return redactTranscriptText(error);
}

function isTerminal(status: ReviewTranscriptStatus): boolean {
  return status === "complete" || status === "failed" || status === "cancelled";
}

export class ReviewerTranscriptStore {
  readonly limits: Readonly<TranscriptLimits>;
  private current?: MutableReviewTranscript;
  private previous?: MutableReviewTranscript;
  private sequence = 0;
  private readonly listeners = new Set<TranscriptListener>();

  constructor(limits: Partial<TranscriptLimits> = {}) {
    this.limits = resolveLimits(limits);
  }

  startReview(input: StartReviewInput, at = Date.now()): string {
    validateTimestamp(at);
    this.sequence += 1;
    const runId = normalizeIdentifier(
      input.runId ?? `review-${Math.trunc(at)}-${this.sequence}`,
      "review run id",
    );
    if (this.current) {
      if (!isTerminal(this.current.status)) {
        this.current.status = "cancelled";
        this.current.updatedAt = at;
        this.current.completedAt = at;
      }
      this.previous = this.current;
    }
    this.current = {
      runId,
      scopeLabel: sanitizeText(input.scopeLabel, this.limits.maxTextChars),
      scopeSummary: sanitizeText(input.scopeSummary, this.limits.maxValueChars),
      status: "started",
      startedAt: at,
      updatedAt: at,
      droppedItems: 0,
      items: [],
      nextItemId: 1,
      reviewers: new Map(),
    };
    this.notify(this.current);
    return runId;
  }

  startReviewer(
    runId: string,
    descriptor: ReviewerTranscriptDescriptor,
    at = Date.now(),
  ): ReviewerTranscript | undefined {
    validateTimestamp(at);
    const review = this.activeReview(runId);
    if (!review) return undefined;
    const safeDescriptor = sanitizeDescriptor(
      descriptor,
      this.limits.maxTextChars,
    );
    if (
      !review.reviewers.has(safeDescriptor.id) &&
      review.reviewers.size >= this.limits.maxReviewersPerReview
    ) {
      throw new RangeError("Maximum reviewers per review exceeded");
    }
    const reviewer: MutableReviewerTranscript = {
      descriptor: safeDescriptor,
      status: "running",
      startedAt: at,
      updatedAt: at,
      droppedItems: 0,
      items: [],
      nextItemId: 1,
    };
    review.reviewers.delete(safeDescriptor.id);
    review.reviewers.set(safeDescriptor.id, reviewer);
    review.status = "running";
    review.updatedAt = at;
    this.notify(review, safeDescriptor.id);
    return cloneReview(review).reviewers.at(-1);
  }

  record(
    runId: string,
    reviewerId: string,
    input: ReviewerTranscriptInput,
    at = Date.now(),
  ): ReviewerTranscriptItem | undefined {
    validateTimestamp(at);
    const review = this.activeReview(runId);
    if (!review) return undefined;
    const reviewer = this.findReviewer(review, reviewerId);
    if (!reviewer || isTerminal(reviewer.status)) return undefined;
    const rawKind = (input as { kind?: unknown } | undefined)?.kind;
    if (
      rawKind === "thinking" ||
      rawKind === "thinking_start" ||
      rawKind === "thinking_delta" ||
      rawKind === "reasoning" ||
      rawKind === "reasoning_delta"
    ) {
      return undefined;
    }
    if (!input || typeof input !== "object") return undefined;

    const stage =
      input.stage === undefined
        ? reviewer.descriptor.stage
        : validateStage(input.stage);
    if (input.kind === "assistant" && input.append) {
      const previous = reviewer.items.at(-1);
      if (previous?.kind === "assistant" && previous.stage === stage) {
        previous.text = sanitizeText(
          `${previous.text}${redactTranscriptText(input.text)}`,
          this.limits.maxTextChars,
        );
        previous.at = at;
        this.touch(review, reviewer, at);
        return { ...previous };
      }
    }

    const base = { id: reviewer.nextItemId++, at, stage };
    let item: ReviewerTranscriptItem;
    switch (input.kind) {
      case "prompt":
        item = {
          ...base,
          kind: "prompt",
          text: sanitizeText(input.text, this.limits.maxTextChars),
        };
        break;
      case "assistant":
        item = {
          ...base,
          kind: "assistant",
          text: sanitizeText(input.text, this.limits.maxTextChars),
        };
        break;
      case "tool_call":
        item = {
          ...base,
          kind: "tool_call",
          toolName: sanitizeText(input.toolName, this.limits.maxTextChars),
          ...(input.toolCallId === undefined
            ? {}
            : {
                toolCallId: sanitizeText(
                  input.toolCallId,
                  this.limits.maxTextChars,
                ),
              }),
          arguments: serializeTranscriptValue(
            input.arguments,
            this.limits.maxValueChars,
            {
              maxDepth: this.limits.maxDepth,
              maxCollectionEntries: this.limits.maxCollectionEntries,
            },
          ),
        };
        break;
      case "tool_result":
        item = {
          ...base,
          kind: "tool_result",
          toolName: sanitizeText(input.toolName, this.limits.maxTextChars),
          ...(input.toolCallId === undefined
            ? {}
            : {
                toolCallId: sanitizeText(
                  input.toolCallId,
                  this.limits.maxTextChars,
                ),
              }),
          isError: input.isError === true,
          summary: summarizeToolResult(input.result, this.limits.maxValueChars),
        };
        break;
      case "final_review":
        item = {
          ...base,
          kind: "final_review",
          review: serializeTranscriptValue(
            input.review,
            this.limits.maxValueChars,
            {
              maxDepth: this.limits.maxDepth,
              maxCollectionEntries: this.limits.maxCollectionEntries,
            },
          ),
        };
        break;
      case "error":
        item = {
          ...base,
          kind: "error",
          message: sanitizeText(
            errorMessage(input.error),
            this.limits.maxTextChars,
          ),
        };
        break;
      case "note":
        item = {
          ...base,
          kind: "note",
          text: sanitizeText(input.text, this.limits.maxTextChars),
        };
        break;
      case "status": {
        const status = sanitizeText(input.status, this.limits.maxTextChars);
        item = {
          ...base,
          kind: "status",
          status,
          text: sanitizeText(input.text ?? status, this.limits.maxTextChars),
        };
        break;
      }
      default:
        return undefined;
    }

    reviewer.items.push(item);
    if (reviewer.items.length > this.limits.maxItemsPerReviewer) {
      reviewer.items.shift();
      reviewer.droppedItems += 1;
    }
    this.touch(review, reviewer, at);
    return { ...item };
  }

  recordRunItem(
    runId: string,
    input: ReviewTranscriptRunInput,
    at = Date.now(),
  ): ReviewTranscriptRunItem | undefined {
    validateTimestamp(at);
    const review = this.activeReview(runId);
    if (!review) return undefined;
    const text = sanitizeText(
      input.kind === "status" ? (input.text ?? input.status) : input.text,
      this.limits.maxTextChars,
    );
    const item: ReviewTranscriptRunItem =
      input.kind === "status"
        ? {
            id: review.nextItemId++,
            at,
            kind: "status",
            status: sanitizeText(input.status, this.limits.maxTextChars),
            text,
          }
        : { id: review.nextItemId++, at, kind: "note", text };
    review.items.push(item);
    if (review.items.length > this.limits.maxRunItems) {
      review.items.shift();
      review.droppedItems += 1;
    }
    review.updatedAt = at;
    this.notify(review);
    return { ...item };
  }

  setReviewerStage(
    runId: string,
    reviewerId: string,
    stage: ReviewerTranscriptStage,
    at = Date.now(),
  ): ReviewerTranscript | undefined {
    validateTimestamp(at);
    const review = this.activeReview(runId);
    if (!review) return undefined;
    const reviewer = this.findReviewer(review, reviewerId);
    if (!reviewer) return undefined;
    reviewer.descriptor.stage = validateStage(stage);
    reviewer.status = "running";
    reviewer.completedAt = undefined;
    this.touch(review, reviewer, at);
    return this.cloneReviewer(review, reviewer.descriptor.id);
  }

  setReviewerStatus(
    runId: string,
    reviewerId: string,
    status: Exclude<ReviewTranscriptStatus, "started">,
    at = Date.now(),
  ): ReviewerTranscript | undefined {
    validateTimestamp(at);
    const review = this.activeReview(runId);
    if (!review) return undefined;
    const reviewer = this.findReviewer(review, reviewerId);
    if (!reviewer || isTerminal(reviewer.status)) return undefined;
    reviewer.status = status;
    reviewer.updatedAt = at;
    reviewer.completedAt = isTerminal(status) ? at : undefined;
    review.updatedAt = at;
    this.notify(review, reviewer.descriptor.id);
    return this.cloneReviewer(review, reviewer.descriptor.id);
  }

  setReviewStatus(
    runId: string,
    status: Exclude<ReviewTranscriptStatus, "started">,
    at = Date.now(),
  ): ReviewTranscriptSnapshot | undefined {
    validateTimestamp(at);
    const review = this.activeReview(runId);
    if (!review) return undefined;
    review.status = status;
    review.updatedAt = at;
    review.completedAt = isTerminal(status) ? at : undefined;
    this.notify(review);
    return cloneReview(review);
  }

  getSnapshot(runId: string): ReviewTranscriptSnapshot | undefined {
    const normalized = normalizeIdentifier(runId, "review run id");
    if (this.current?.runId === normalized) return cloneReview(this.current);
    if (this.previous?.runId === normalized) return cloneReview(this.previous);
    return undefined;
  }

  getLatestSnapshot(): ReviewTranscriptSnapshot | undefined {
    return this.current ? cloneReview(this.current) : undefined;
  }

  getPreviousSnapshot(): ReviewTranscriptSnapshot | undefined {
    return this.previous ? cloneReview(this.previous) : undefined;
  }

  listSnapshots(): ReviewTranscriptSnapshot[] {
    return [this.previous, this.current]
      .filter((review): review is MutableReviewTranscript => Boolean(review))
      .map(cloneReview);
  }

  clear(): void {
    this.current = undefined;
    this.previous = undefined;
  }

  subscribe(listener: TranscriptListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private activeReview(runId: string): MutableReviewTranscript | undefined {
    const normalized = normalizeIdentifier(runId, "review run id");
    if (this.current?.runId !== normalized || isTerminal(this.current.status)) {
      return undefined;
    }
    return this.current;
  }

  private findReviewer(
    review: MutableReviewTranscript,
    reviewerId: string,
  ): MutableReviewerTranscript | undefined {
    const id = normalizeIdentifier(reviewerId, "reviewer id");
    return review.reviewers.get(id);
  }

  private touch(
    review: MutableReviewTranscript,
    reviewer: MutableReviewerTranscript,
    at: number,
  ): void {
    reviewer.updatedAt = at;
    review.updatedAt = at;
    this.notify(review, reviewer.descriptor.id);
  }

  private cloneReviewer(
    review: MutableReviewTranscript,
    reviewerId: string,
  ): ReviewerTranscript | undefined {
    return cloneReview(review).reviewers.find(
      ({ descriptor }) => descriptor.id === reviewerId,
    );
  }

  private notify(review: MutableReviewTranscript, reviewerId?: string): void {
    for (const listener of this.listeners) {
      try {
        listener({
          runId: review.runId,
          reviewerId,
          snapshot: cloneReview(review),
        });
      } catch {
        // A broken viewer must never interrupt the reviewer workflow.
      }
    }
  }
}
