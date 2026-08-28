import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import {
  parseMakerCaptureRepriceProofV1,
  type MakerCaptureBookDecisionProofV1,
  type MakerCaptureTriggerProofV1,
  type Order,
  type OrderBookSnapshot,
} from "@krabs/domain";
import {
  computeMakerCaptureCandidate,
  parseMakerCaptureLineage,
} from "../../apps/runtime/src/maker-capture-reprice.js";
import { parseQuoteMotionOrigin } from "../../apps/runtime/src/quote-motion-shadow.js";

const CLASSIFICATIONS = ["TECHNICAL", "ACTIVE", "FILLABLE", "NO_FILL"] as const;
const INTENT_STATUSES = ["cancel_pending", "ready", "submitted", "completed", "failed"] as const;
const ORDER_STATUSES = ["open", "partially-filled", "filled", "cancelled"] as const;
const ACCEPTED = new Set<string>(ORDER_STATUSES);
const WORKING = new Set(["open", "partially-filled"]);
const TERMINAL = new Set(["filled", "cancelled"]);
const EPSILON = 1e-8;

type Classification = (typeof CLASSIFICATIONS)[number];
type IntentStatus = (typeof INTENT_STATUSES)[number];
type OrderStatus = (typeof ORDER_STATUSES)[number];
type Lineage = NonNullable<ReturnType<typeof parseMakerCaptureLineage>>;
type Origin = NonNullable<ReturnType<typeof parseQuoteMotionOrigin>>;

interface OrderRow {
  order_id: string;
  client_order_id: string;
  token_id: string;
  condition_id: string;
  side: string;
  post_only: number;
  price: number;
  size: number;
  size_usdc: number;
  status: string;
  cancel_reason: string | null;
  exchange_order_id: string | null;
  signal_id: string | null;
  signal_reason: string | null;
  decision_rule_id: string | null;
  entry_style: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
}

interface FillRow {
  fill_id: string;
  order_id: string;
  token_id: string;
  condition_id: string;
  side: string;
  size: number;
  size_usdc: number;
  filled_at: string;
}

interface IntentRow {
  intent_id: string;
  predecessor_order_id: string;
  lifecycle_signal_id: string;
  root_order_id: string;
  token_id: string;
  condition_id: string;
  replacement_index: number;
  status: string;
  candidate_price: number | null;
  replacement_size: number | null;
  child_order_id: string | null;
  failure: string | null;
  proof_json: string;
  created_at: string;
  updated_at: string;
}

interface Member {
  order: OrderRow;
  lineage: Lineage | null;
  accepted: boolean;
  fills: FillRow[];
  invalidFills: number;
}

interface Pricing {
  bestBid: number;
  bestAsk: number;
  tickSize: number;
  entryPriceCeiling: number;
  originalSuggestedPrice: number;
}

export interface PermanentR23LineageOptions {
  ledger: string;
  deployMeta: string;
  expectedSha: string;
  activationId: string;
  activatedAt: string;
  reconciliationGraceMs: number;
  asOf: string;
}

function binding(options: PermanentR23LineageOptions) {
  if (!/^[0-9a-f]{40}$/.test(options.expectedSha))
    throw new Error("--expected-sha must be a lowercase 40-character Git SHA");
  if (!text(options.activationId) || options.activationId.trim() !== options.activationId)
    throw new Error("--activation-id must be a non-empty exact identifier");
  if (!Number.isSafeInteger(options.reconciliationGraceMs) || options.reconciliationGraceMs <= 0)
    throw new Error("--reconciliation-grace-ms must be a positive integer");
  const activatedAt = instant(options.activatedAt, "--activated-at");
  const asOf = instant(options.asOf, "--as-of");
  const deploy = deployReceipt(options.deployMeta, options.expectedSha);
  if (Date.parse(asOf) < Math.max(Date.parse(activatedAt), Date.parse(deploy.deployedAt)))
    throw new Error("--as-of must not precede the deployment receipt or activation");
  if (Date.parse(activatedAt) < Date.parse(deploy.deployedAt))
    throw new Error("activation tuple predates the deployment receipt");
  return {
    ...deploy,
    activationId: options.activationId,
    activatedAt,
    asOf,
    reconciliationGraceMs: options.reconciliationGraceMs,
  };
}

function deployReceipt(path: string, expectedSha: string) {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("deploy metadata is missing or malformed");
  }
  if (
    !record(raw) ||
    raw.sha !== expectedSha ||
    !record(raw.receipt) ||
    raw.receipt.sha !== expectedSha
  )
    throw new Error("deploy metadata SHA/receipt binding is invalid");
  return { expectedSha, deployedAt: deployInstant(raw.deployedAt) };
}

type Binding = ReturnType<typeof binding>;

export function analyzePermanentR23Lineages(options: PermanentR23LineageOptions) {
  const bound = binding(options);
  const db = new Database(options.ledger, { readonly: true, fileMustExist: true });
  try {
    db.pragma("query_only = ON");
    assertSchema(db);
    db.exec("BEGIN");
    const report = snapshot(db, bound);
    db.exec("COMMIT");
    return report;
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

function snapshot(db: Database.Database, bound: Binding) {
  const orders = db
    .prepare(
      `SELECT order_id,client_order_id,token_id,condition_id,side,post_only,price,size,size_usdc,status,
            cancel_reason,exchange_order_id,signal_id,signal_reason,decision_rule_id,entry_style,
            metadata_json,created_at,updated_at FROM orders
     WHERE decision_rule_id='R23_DIP_TRIGGER' AND created_at>=? AND created_at<=?
     ORDER BY created_at,order_id`,
    )
    .all(bound.deployedAt, bound.asOf) as OrderRow[];
  const candidates = orders.filter((order) => rootMatches(order, bound));
  if (candidates.length === 0) throw new Error("exact permanent R23 activation tuple not found");
  assertTimes(candidates, bound.asOf, "order");
  const rootFills = fillsFor(
    db,
    candidates.map(({ order_id }) => order_id),
    bound.asOf,
  );
  const accepted = candidates.filter((order) => acceptedOrder(order, rootFills));
  return report(
    db,
    bound,
    candidates.length,
    accepted.map((root) => analyzeRoot(db, root, orders, bound)),
  );
}

function rootMatches(order: OrderRow, bound: Binding): boolean {
  const life = lifecycle(order);
  const line = lineage(order);
  const quote = origin(order);
  return Boolean(
    captureOrder(order) &&
    life &&
    line &&
    quote &&
    life.activationId === bound.activationId &&
    life.activatedAtUtc === bound.activatedAt &&
    line.rootOrderId === order.order_id &&
    line.predecessorOrderId === null &&
    line.replacementIndex === 0 &&
    quote.kind === "r23_capture" &&
    quote.cohortId === bound.activatedAt &&
    quote.permanentR23ActivationId === bound.activationId &&
    quote.permanentR23ActivatedAtUtc === bound.activatedAt &&
    canonical(order.created_at) &&
    Date.parse(order.created_at) >=
      Math.max(Date.parse(bound.deployedAt), Date.parse(bound.activatedAt)),
  );
}

function analyzeRoot(db: Database.Database, root: OrderRow, orders: OrderRow[], bound: Binding) {
  const members = orders.filter((order) => lineage(order)?.rootOrderId === root.order_id);
  assertTimes(members, bound.asOf, "order");
  const fills = fillsFor(
    db,
    members.map(({ order_id }) => order_id),
    bound.asOf,
  );
  const built = members.map((order) => member(order, fills));
  const intents = db
    .prepare(
      `SELECT intent_id,predecessor_order_id,lifecycle_signal_id,root_order_id,token_id,condition_id,
            replacement_index,status,candidate_price,replacement_size,child_order_id,failure,
            proof_json,created_at,updated_at FROM maker_capture_reprice_intents
     WHERE root_order_id=? ORDER BY replacement_index,intent_id`,
    )
    .all(root.order_id) as IntentRow[];
  assertTimes(intents, bound.asOf, "intent");
  const transitions = transitionCounts(root, built, intents);
  const acceptedMembers = built.filter(({ accepted }) => accepted);
  const validFills = acceptedMembers.flatMap(({ fills: rows }) => rows);
  const deadline = deadlineMs(root);
  const timely = validFills.filter(({ filled_at }) => Date.parse(filled_at) <= deadline);
  const late = validFills.filter(({ filled_at }) => Date.parse(filled_at) > deadline);
  const prices = acceptedMembers.map((entry) => pricing(entry, root, intents));
  const rootNotional = lineage(root)?.rootNotionalUsdc ?? 0;
  const entryViolations = acceptedMembers.filter((entry, index) => {
    const proof = prices[index];
    return (
      !proof ||
      entry.order.price > Math.min(proof.entryPriceCeiling, proof.originalSuggestedPrice) + EPSILON
    );
  }).length;
  const notionalViolation =
    sum(validFills.map(({ size_usdc }) => size_usdc)) > rootNotional + EPSILON ||
    acceptedMembers.some((entry) => restingCeilingViolation(entry, acceptedMembers, rootNotional));
  const parity =
    lineageParity(root, built, intents, transitions) &&
    late.length === 0 &&
    prices.every(
      (proof, index) => proof && acceptedMembers[index]!.order.price < proof.bestAsk - EPSILON,
    ) &&
    entryViolations === 0 &&
    !notionalViolation;
  const classification = classify(
    built,
    intents,
    parity,
    timely.length,
    late.length,
    deadline,
    bound,
  );
  return {
    classification,
    parity: parity && classification !== "TECHNICAL",
    members: acceptedMembers,
    unaccepted: built.length - acceptedMembers.length,
    intents,
    transitions,
    timely: timely.length,
    late: late.length,
    fillLatencies: validFills.map(
      ({ filled_at }) => Date.parse(filled_at) - Date.parse(root.created_at),
    ),
    terminalLatency: terminalLatency(root, acceptedMembers),
    prices,
    rootNotional,
    entryViolations,
    notionalViolation,
  };
}

type Analysis = ReturnType<typeof analyzeRoot>;

function member(order: OrderRow, fills: FillRow[]): Member {
  const own = fills.filter(({ order_id }) => order_id === order.order_id);
  const valid = own.filter((fill) => validFill(fill, order));
  return {
    order,
    lineage: lineage(order),
    accepted: acceptedOrder(order, own),
    fills: valid,
    invalidFills: own.length - valid.length,
  };
}

function transitionCounts(root: OrderRow, members: Member[], intents: IntentRow[]) {
  let accepted = 0,
    failed = 0,
    invalid = 0;
  for (const intent of intents) {
    const valid = transitionValid(root, members, intent);
    if (intent.status === "failed") failed++;
    else if (valid) accepted++;
    else invalid++;
  }
  return { accepted, failed, invalid };
}

function transitionValid(root: OrderRow, members: Member[], intent: IntentRow): boolean {
  const predecessor = members.find(({ order }) => order.order_id === intent.predecessor_order_id);
  const child = members.find(({ order }) => order.order_id === intent.child_order_id);
  return Boolean(
    predecessor?.accepted &&
    child?.accepted &&
    predecessor.lineage &&
    child.lineage &&
    (intent.status === "submitted" || intent.status === "completed") &&
    predecessor.order.status === "cancelled" &&
    predecessor.order.cancel_reason === "maker_capture_reprice" &&
    intent.root_order_id === root.order_id &&
    intent.token_id === root.token_id &&
    intent.condition_id === root.condition_id &&
    intent.lifecycle_signal_id === child.order.signal_id &&
    child.lineage.rootOrderId === root.order_id &&
    child.lineage.predecessorOrderId === predecessor.order.order_id &&
    child.lineage.replacementIndex === intent.replacement_index &&
    predecessor.lineage.replacementIndex === intent.replacement_index - 1 &&
    equal(intent.candidate_price, child.order.price) &&
    equal(intent.replacement_size, child.order.size) &&
    validProof(root, predecessor, child, members, intent),
  );
}

function validProof(
  root: OrderRow,
  predecessor: Member,
  child: Member,
  members: Member[],
  intent: IntentRow,
): boolean {
  const proof = parseMakerCaptureRepriceProofV1(json(intent.proof_json));
  if (!proof?.prepared || !proof.submit) return false;
  const chainFilled = priorFilled(members, intent.replacement_index);
  const remaining = Math.max(
    0,
    predecessor.order.size - sum(predecessor.fills.map(({ size }) => size)),
  );
  const committed = chainFilled + child.order.price * child.order.size;
  return [
    proof.submit.childOrderId === child.order.order_id &&
      proof.submit.clientOrderId === child.order.client_order_id,
    triggerMatches(proof.trigger, root),
    orderProof(proof.prepared, child.order, intent),
    orderProof(proof.submit, child.order, intent),
    rootProof(proof.prepared, root, chainFilled),
    rootProof(proof.submit, root, chainFilled),
    equal(proof.prepared.predecessorPrice, predecessor.order.price),
    equal(proof.submit.predecessorPrice, predecessor.order.price),
    equal(proof.prepared.predecessorRemainingShares, remaining),
    equal(proof.submit.predecessorRemainingShares, remaining),
    sameFrozenProof(proof.prepared, proof.submit),
    proofCandidateMatches(child.order, proof.prepared),
    proofCandidateMatches(child.order, proof.submit),
    committed <= proof.prepared.rootNotionalUsdc + EPSILON,
    committed <= proof.submit.rootNotionalUsdc + EPSILON,
  ].every(Boolean);
}

function triggerMatches(proof: MakerCaptureTriggerProofV1, root: OrderRow): boolean {
  const life = lifecycle(root),
    quote = origin(root),
    line = lineage(root);
  return Boolean(
    life &&
    quote &&
    line &&
    proof.activatedAtUtc === life.activatedAtUtc &&
    proof.expiresAtUtc === new Date(deadlineMs(root)).toISOString() &&
    proof.policySchemaVersion === quote.policySchemaVersion &&
    proof.policyControlRevision === quote.policyControlRevision &&
    proof.entryPriceCeiling === quote.entryPriceCeiling &&
    proof.originalSuggestedPrice === quote.originalSuggestedPrice &&
    equal(proof.rootNotionalUsdc, line.rootNotionalUsdc),
  );
}

function rootProof(
  proof: MakerCaptureBookDecisionProofV1,
  root: OrderRow,
  chainFilled: number,
): boolean {
  const life = lifecycle(root),
    quote = origin(root),
    line = lineage(root);
  return Boolean(
    life &&
    quote &&
    line &&
    equal(proof.rootNotionalUsdc, line.rootNotionalUsdc) &&
    equal(proof.chainFilledUsdc, chainFilled) &&
    proof.activatedAtUtc === life.activatedAtUtc &&
    proof.expiresAtUtc === new Date(deadlineMs(root)).toISOString() &&
    proof.policySchemaVersion === quote.policySchemaVersion &&
    proof.policyControlRevision === quote.policyControlRevision &&
    proof.entryPriceCeiling === quote.entryPriceCeiling &&
    proof.originalSuggestedPrice === quote.originalSuggestedPrice,
  );
}

function orderProof(
  proof: MakerCaptureBookDecisionProofV1,
  child: OrderRow,
  intent: IntentRow,
): boolean {
  return (
    equal(proof.candidatePrice, child.price) &&
    equal(proof.candidatePrice, intent.candidate_price ?? NaN) &&
    equal(proof.replacementSize, child.size) &&
    equal(proof.replacementSize, intent.replacement_size ?? NaN)
  );
}

function sameFrozenProof(
  left: MakerCaptureBookDecisionProofV1,
  right: MakerCaptureBookDecisionProofV1,
): boolean {
  return (
    [
      "candidatePrice",
      "replacementSize",
      "rootNotionalUsdc",
      "chainFilledUsdc",
      "activatedAtUtc",
      "expiresAtUtc",
      "policySchemaVersion",
      "policyControlRevision",
      "entryPriceCeiling",
      "originalSuggestedPrice",
    ] as const
  ).every((key) => left[key] === right[key]);
}

function lineageParity(
  root: OrderRow,
  members: Member[],
  intents: IntentRow[],
  transitions: ReturnType<typeof transitionCounts>,
): boolean {
  const rootLine = lineage(root);
  if (
    !rootLine ||
    rootLine.rootOrderId !== root.order_id ||
    rootLine.predecessorOrderId !== null ||
    rootLine.replacementIndex !== 0 ||
    !equal(rootLine.rootNotionalUsdc, root.size_usdc)
  )
    return false;
  const accepted = members.filter((entry) => entry.accepted);
  const indices = accepted
    .map((entry) => entry.lineage?.replacementIndex ?? -1)
    .sort((a, b) => a - b);
  return (
    indices.every((value, index) => value === index) &&
    members.every((entry) => memberMatches(entry, root, rootLine)) &&
    members.every((entry) => entry.accepted || entry.order.order_id === root.order_id) &&
    transitions.invalid === 0 &&
    transitions.failed === 0 &&
    intents.length === transitions.accepted &&
    transitions.accepted === accepted.length - 1
  );
}

function memberMatches(entry: Member, root: OrderRow, rootLine: Lineage): boolean {
  const life = lifecycle(entry.order),
    rootLife = lifecycle(root),
    line = entry.lineage;
  return Boolean(
    line &&
    life &&
    rootLife &&
    entry.invalidFills === 0 &&
    captureOrder(entry.order) &&
    life.activationId === rootLife.activationId &&
    life.activatedAtUtc === rootLife.activatedAtUtc &&
    line.rootOrderId === root.order_id &&
    equal(line.rootNotionalUsdc, rootLine.rootNotionalUsdc) &&
    entry.order.token_id === root.token_id &&
    entry.order.condition_id === root.condition_id &&
    entry.order.created_at >= root.created_at &&
    statusMatchesFills(entry),
  );
}

function statusMatchesFills(entry: Member): boolean {
  const filled = sum(entry.fills.map(({ size }) => size));
  if (filled > entry.order.size + EPSILON) return false;
  if (entry.order.status === "filled") return filled >= entry.order.size - EPSILON;
  if (entry.order.status === "partially-filled")
    return filled > EPSILON && filled < entry.order.size;
  if (entry.order.status === "open") return filled <= EPSILON;
  return entry.order.status === "cancelled";
}

function classify(
  members: Member[],
  intents: IntentRow[],
  parity: boolean,
  timely: number,
  late: number,
  deadline: number,
  bound: Binding,
): Classification {
  const accepted = members.filter((entry) => entry.accepted);
  const afterGrace = Date.parse(bound.asOf) >= deadline + bound.reconciliationGraceMs;
  const working = accepted.some(({ order }) => WORKING.has(order.status));
  const incomplete = intents.some(
    ({ status }) => status === "cancel_pending" || status === "ready" || status === "submitted",
  );
  if (!parity || late > 0 || (afterGrace && (working || incomplete))) return "TECHNICAL";
  if (working || incomplete) return "ACTIVE";
  if (timely > 0) return "FILLABLE";
  if (!afterGrace) return "ACTIVE";
  const leaf = [...accepted]
    .sort((a, b) => (a.lineage?.replacementIndex ?? -1) - (b.lineage?.replacementIndex ?? -1))
    .at(-1);
  return leaf?.order.status === "cancelled" &&
    leaf.order.cancel_reason === "stale_entry_ttl" &&
    Date.parse(leaf.order.updated_at) >= deadline &&
    accepted.every(({ order }) => TERMINAL.has(order.status))
    ? "NO_FILL"
    : "TECHNICAL";
}

function pricing(entry: Member, root: OrderRow, intents: IntentRow[]): Pricing | null {
  if (entry.order.order_id === root.order_id) {
    const quote = origin(root),
      book = record(quote?.initialBook) ? quote.initialBook : null;
    if (!quote || !book || book.depthStatus !== "full") return null;
    const result = pricingValues(
      book.bestBid,
      book.bestAsk,
      book.tickSize,
      quote.entryPriceCeiling,
      quote.originalSuggestedPrice,
    );
    return result && candidateMatches(root, result, result.bestBid) ? result : null;
  }
  const intent = intents.find(({ child_order_id }) => child_order_id === entry.order.order_id);
  const submit = intent ? parseMakerCaptureRepriceProofV1(json(intent.proof_json))?.submit : null;
  return submit
    ? pricingValues(
        submit.externalBestBid,
        submit.externalBestAsk,
        submit.tickSize,
        submit.entryPriceCeiling,
        submit.originalSuggestedPrice,
      )
    : null;
}

function pricingValues(
  bestBid: unknown,
  bestAsk: unknown,
  tickSize: unknown,
  ceiling: unknown,
  suggested: unknown,
): Pricing | null {
  return positive(bestBid) &&
    positive(bestAsk) &&
    positive(tickSize) &&
    positive(ceiling) &&
    positive(suggested)
    ? { bestBid, bestAsk, tickSize, entryPriceCeiling: ceiling, originalSuggestedPrice: suggested }
    : null;
}

function candidateMatches(order: OrderRow, proof: Pricing, predecessorPrice: number): boolean {
  const candidate = computeMakerCaptureCandidate({
    book: {
      tokenId: order.token_id,
      bids: [{ price: proof.bestBid, size: 1 }],
      asks: [{ price: proof.bestAsk, size: 1 }],
      bestBid: proof.bestBid,
      bestAsk: proof.bestAsk,
      midPrice: (proof.bestBid + proof.bestAsk) / 2,
      spread: proof.bestAsk - proof.bestBid,
      minOrderSize: null,
      timestamp: Date.parse(order.created_at),
    } as OrderBookSnapshot,
    tickSize: proof.tickSize,
    predecessorPrice,
    predecessorVisibleShares: 0,
    originalSuggestedPrice: proof.originalSuggestedPrice,
    entryPriceCeiling: proof.entryPriceCeiling,
  });
  return candidate.ok && equal(candidate.price, order.price);
}

function proofCandidateMatches(order: OrderRow, proof: MakerCaptureBookDecisionProofV1): boolean {
  const values = pricingValues(
    proof.externalBestBid,
    proof.externalBestAsk,
    proof.tickSize,
    proof.entryPriceCeiling,
    proof.originalSuggestedPrice,
  );
  return Boolean(values && candidateMatches(order, values, proof.predecessorPrice));
}

function restingCeilingViolation(entry: Member, members: Member[], rootNotional: number): boolean {
  return Boolean(
    WORKING.has(entry.order.status) &&
    entry.lineage &&
    priorFilled(members, entry.lineage.replacementIndex) + entry.order.price * entry.order.size >
      rootNotional + EPSILON,
  );
}

function priorFilled(members: Member[], index: number): number {
  return decimal(
    members
      .filter((entry) => (entry.lineage?.replacementIndex ?? -1) < index)
      .flatMap(({ fills }) => fills.map(({ size_usdc }) => size_usdc)),
  );
}

function report(db: Database.Database, bound: Binding, candidates: number, analyses: Analysis[]) {
  const members = analyses.flatMap(({ members: rows }) => rows);
  const fills = members.flatMap(({ fills: rows }) => rows);
  const prices = analyses.flatMap(({ prices: rows }) => rows);
  const intents = analyses.flatMap(({ intents: rows }) => rows);
  return {
    schemaVersion: 1 as const,
    aggregateOnly: true as const,
    binding: bound,
    coverage: {
      candidateRoots: candidates,
      acceptedRoots: analyses.length,
      unacceptedRoots: candidates - analyses.length,
    },
    lineages: {
      total: analyses.length,
      classifications: counts(
        CLASSIFICATIONS,
        analyses.map(({ classification }) => classification),
      ),
    },
    orders: {
      accepted: members.length,
      unacceptedLineageMembers: sum(analyses.map(({ unaccepted }) => unaccepted)),
      statuses: counts(
        ORDER_STATUSES,
        members.map(({ order }) => order.status as OrderStatus),
      ),
    },
    intents: {
      total: intents.length,
      statuses: counts(
        INTENT_STATUSES,
        intents.map(({ status }) => status as IntentStatus),
      ),
      acceptedTransitions: sum(analyses.map(({ transitions }) => transitions.accepted)),
      failedTransitions: sum(analyses.map(({ transitions }) => transitions.failed)),
      invalidTransitions: sum(analyses.map(({ transitions }) => transitions.invalid)),
      failures: stringCounts(
        intents.flatMap(({ failure }) => (failure ? [failureClass(failure)] : [])),
      ),
    },
    parity: {
      validLineages: analyses.filter(({ parity }) => parity).length,
      invalidLineages: analyses.filter(({ parity }) => !parity).length,
    },
    fills: {
      count: fills.length,
      invalid: sum(members.map(({ invalidFills }) => invalidFills)),
      timely: sum(analyses.map(({ timely }) => timely)),
      late: sum(analyses.map(({ late }) => late)),
      shares: decimal(fills.map(({ size }) => size)),
      notionalUsdc: decimal(fills.map(({ size_usdc }) => size_usdc)),
    },
    timing: {
      fillLatencyMs: distribution(analyses.flatMap(({ fillLatencies }) => fillLatencies)),
      terminalLatencyMs: distribution(
        analyses.flatMap(({ terminalLatency }) =>
          terminalLatency === null ? [] : [terminalLatency],
        ),
      ),
    },
    directPnl: directPnl(db, new Set(members.map(({ order }) => order.order_id)), bound.asOf),
    pricing: aggregatePricing(members, prices),
    ceilings: {
      acceptedRootNotionalUsdc: decimal(analyses.map(({ rootNotional }) => rootNotional)),
      filledNotionalUsdc: decimal(fills.map(({ size_usdc }) => size_usdc)),
      rootNotionalViolations: analyses.filter(({ notionalViolation }) => notionalViolation).length,
      entryPriceViolations: sum(analyses.map(({ entryViolations }) => entryViolations)),
    },
  };
}

export type PermanentR23LineageReadout = ReturnType<typeof report>;

function aggregatePricing(members: Member[], proofs: (Pricing | null)[]) {
  let exact = 0,
    nonCrossing = 0,
    crossing = 0;
  proofs.forEach((proof, index) => {
    if (!proof) return;
    const price = members[index]!.order.price;
    if (equal(price, proof.bestBid + proof.tickSize)) exact++;
    if (price < proof.bestAsk - EPSILON) nonCrossing++;
    else crossing++;
  });
  const unavailable = proofs.filter((proof) => !proof).length;
  return {
    observations: members.length,
    bidPlusOneExact: exact,
    bidPlusOneOther: members.length - unavailable - exact,
    nonCrossing,
    crossingViolations: crossing,
    unavailable,
  };
}

function directPnl(db: Database.Database, orders: Set<string>, asOf: string) {
  if (orders.size === 0)
    return { status: "AVAILABLE" as const, rows: 0, unavailableRows: 0, delta: 0 };
  const marks = [...orders].map(() => "?").join(",");
  const touched = db
    .prepare(
      `SELECT DISTINCT il.position_id FROM inventory_lots il
    JOIN fills f ON f.fill_id=il.fill_id WHERE f.order_id IN (${marks}) AND f.side='buy'`,
    )
    .all(...orders) as { position_id: string }[];
  const exact = new Set(
    touched
      .filter(({ position_id }) => positionSourcesExact(db, position_id, orders))
      .map(({ position_id }) => position_id),
  );
  if (touched.length === 0)
    return { status: "AVAILABLE" as const, rows: 0, unavailableRows: 0, delta: 0 };
  const positions = touched.map(({ position_id }) => position_id),
    positionMarks = positions.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT pl.position_id,pl.delta,pl.filled_at,f.side fill_side,
      f.token_id fill_token,f.condition_id fill_condition,p.token_id position_token,
      p.condition_id position_condition,o.position_id order_position FROM pnl_ledger pl
    JOIN fills f ON f.fill_id=pl.fill_id JOIN positions p ON p.position_id=pl.position_id
    JOIN orders o ON o.order_id=f.order_id WHERE pl.position_id IN (${positionMarks}) ORDER BY pl.filled_at,pl.id`,
    )
    .all(...positions) as Array<Record<string, string | number | null>>;
  if (
    rows.some(
      (row) =>
        row.fill_side !== "sell" ||
        typeof row.delta !== "number" ||
        !Number.isFinite(row.delta) ||
        !canonical(row.filled_at) ||
        String(row.filled_at) > asOf,
    )
  )
    throw new Error("direct PnL rows cannot be attributed at --as-of");
  const available = rows.filter(
    (row) =>
      exact.has(String(row.position_id)) &&
      row.fill_token === row.position_token &&
      row.fill_condition === row.position_condition &&
      row.order_position === row.position_id,
  );
  const unavailableRows = rows.length - available.length;
  return {
    status:
      unavailableRows === 0
        ? ("AVAILABLE" as const)
        : available.length === 0
          ? ("UNAVAILABLE" as const)
          : ("PARTIAL" as const),
    rows: available.length,
    unavailableRows,
    delta: decimal(available.map((row) => Number(row.delta))),
  };
}

function positionSourcesExact(
  db: Database.Database,
  position: string,
  orders: Set<string>,
): boolean {
  const rows = db
    .prepare(
      `SELECT il.token_id lot_token,f.token_id fill_token,f.side,f.order_id
    FROM inventory_lots il JOIN fills f ON f.fill_id=il.fill_id WHERE il.position_id=?`,
    )
    .all(position) as Array<Record<string, string>>;
  return (
    rows.length > 0 &&
    rows.every(
      (row) =>
        row.side === "buy" &&
        row.lot_token === row.fill_token &&
        typeof row.order_id === "string" &&
        orders.has(row.order_id),
    )
  );
}

function fillsFor(db: Database.Database, ids: string[], asOf: string): FillRow[] {
  if (ids.length === 0) return [];
  const rows = db
    .prepare(
      `SELECT fill_id,order_id,token_id,condition_id,side,size,size_usdc,filled_at
    FROM fills WHERE order_id IN (${ids.map(() => "?").join(",")}) ORDER BY filled_at,fill_id`,
    )
    .all(...ids) as FillRow[];
  if (rows.some(({ filled_at }) => !canonical(filled_at) || filled_at > asOf))
    throw new Error("--as-of precedes a lineage fill update");
  return rows;
}

function assertSchema(db: Database.Database): void {
  const required = {
    orders: [
      "order_id",
      "client_order_id",
      "token_id",
      "condition_id",
      "side",
      "post_only",
      "price",
      "size",
      "size_usdc",
      "status",
      "cancel_reason",
      "exchange_order_id",
      "signal_id",
      "signal_reason",
      "decision_rule_id",
      "entry_style",
      "position_id",
      "metadata_json",
      "created_at",
      "updated_at",
    ],
    fills: [
      "fill_id",
      "order_id",
      "token_id",
      "condition_id",
      "side",
      "size",
      "size_usdc",
      "filled_at",
    ],
    maker_capture_reprice_intents: [
      "intent_id",
      "predecessor_order_id",
      "lifecycle_signal_id",
      "root_order_id",
      "token_id",
      "condition_id",
      "replacement_index",
      "status",
      "candidate_price",
      "replacement_size",
      "child_order_id",
      "failure",
      "proof_json",
      "created_at",
      "updated_at",
    ],
    inventory_lots: ["position_id", "token_id", "side", "fill_id"],
    positions: ["position_id", "token_id", "condition_id"],
    pnl_ledger: ["id", "fill_id", "position_id", "delta", "filled_at"],
  } as const;
  if ((db.prepare("SELECT json_valid('{}') ok").get() as { ok: number }).ok !== 1)
    throw new Error("ledger SQLite JSON1 is unavailable");
  for (const [table, columns] of Object.entries(required)) {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    const actual = new Set(rows.map(({ name }) => name));
    if (!rows.length || columns.some((column) => !actual.has(column)))
      throw new Error(`ledger schema is missing required ${table} columns`);
  }
}

function lifecycle(
  order: OrderRow,
): { activationId: string; activatedAtUtc: string; fillWaitMs: number } | null {
  const raw = metadata(order)?.makerMicroLiveLifecycle;
  const activatedAtUtc = record(raw) ? canonical(raw.activatedAtUtc) : null;
  if (
    !record(raw) ||
    Object.keys(raw).sort().join(",") !== "activatedAtUtc,activationId,fillWaitMs,kind" ||
    raw.kind !== "permanent_r23" ||
    !text(raw.activationId) ||
    !activatedAtUtc ||
    !Number.isSafeInteger(raw.fillWaitMs) ||
    Number(raw.fillWaitMs) <= 0
  )
    return null;
  return {
    activationId: raw.activationId,
    activatedAtUtc,
    fillWaitMs: Number(raw.fillWaitMs),
  };
}

function lineage(order: OrderRow): Lineage | null {
  return parseMakerCaptureLineage({
    metadata: { makerCaptureLineageV1: metadata(order)?.makerCaptureLineageV1 },
  } as unknown as Order);
}

function origin(order: OrderRow): Origin | null {
  return parseQuoteMotionOrigin({
    side: order.side,
    postOnly: order.post_only === 1,
    entryStyle: order.entry_style,
    decisionRuleId: order.decision_rule_id,
    signalReason: order.signal_reason,
    metadata: metadata(order),
  } as unknown as Order);
}

function metadata(order: OrderRow): Record<string, unknown> | null {
  const value = json(order.metadata_json ?? "");
  return record(value) ? value : null;
}

function captureOrder(order: OrderRow): boolean {
  return (
    order.side === "buy" &&
    order.post_only === 1 &&
    order.signal_reason === "probe-entry" &&
    order.decision_rule_id === "R23_DIP_TRIGGER" &&
    order.entry_style === "maker"
  );
}

function acceptedOrder(order: OrderRow, fills: FillRow[]): boolean {
  return (
    ACCEPTED.has(order.status) &&
    (text(order.exchange_order_id) || fills.some((fill) => validFill(fill, order)))
  );
}

function validFill(fill: FillRow, order: OrderRow): boolean {
  return (
    fill.order_id === order.order_id &&
    fill.side === "buy" &&
    fill.token_id === order.token_id &&
    fill.condition_id === order.condition_id &&
    positive(fill.size) &&
    positive(fill.size_usdc)
  );
}

function deadlineMs(root: OrderRow): number {
  const life = lifecycle(root),
    created = Date.parse(root.created_at);
  if (!life || !Number.isFinite(created)) throw new Error("root lifecycle deadline is invalid");
  return created + life.fillWaitMs;
}

function terminalLatency(root: OrderRow, members: Member[]): number | null {
  return !members.length || members.some(({ order }) => !TERMINAL.has(order.status))
    ? null
    : Math.max(...members.map(({ order }) => Date.parse(order.updated_at))) -
        Date.parse(root.created_at);
}

function assertTimes(
  rows: Array<{ created_at: string; updated_at: string }>,
  asOf: string,
  kind: string,
): void {
  if (
    rows.some(
      (row) =>
        !canonical(row.created_at) ||
        !canonical(row.updated_at) ||
        row.created_at > asOf ||
        row.updated_at > asOf,
    )
  )
    throw new Error(`--as-of cannot reconstruct the current ${kind} snapshot`);
}

function distribution(values: number[]) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { count: 0, min: null, median: null, max: null, mean: null };
  const middle = Math.floor(sorted.length / 2);
  return {
    count: sorted.length,
    min: sorted[0]!,
    median: sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2,
    max: sorted.at(-1)!,
    mean: sum(sorted) / sorted.length,
  };
}

function counts<const T extends string>(keys: readonly T[], values: T[]): Record<T, number> {
  return Object.fromEntries(
    keys.map((key) => [key, values.filter((value) => value === key).length]),
  ) as Record<T, number>;
}

function stringCounts(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function failureClass(reason: string): string {
  if (reason.includes("child")) return "child";
  if (reason.startsWith("predecessor-")) return "predecessor";
  if (reason.includes("proof") || reason === "identity-drift") return "proof-or-identity";
  if (reason.includes("policy") || reason.includes("lineage")) return "policy-or-lineage";
  if (reason.includes("book") || reason === "self-book-ambiguous") return "book";
  if (reason.includes("minimum") || reason.includes("size")) return "sizing";
  return reason === "no-valid-move" ? "pricing" : "unknown";
}

function instant(raw: unknown, flag: string): string {
  const value = canonical(raw);
  if (!value) throw new Error(`${flag} must be a canonical ISO-8601 UTC instant`);
  return value;
}

function deployInstant(raw: unknown): string {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(raw))
    throw new Error("deploy metadata deployedAt must be an ISO-8601 UTC instant");
  const milliseconds = Date.parse(raw);
  if (!Number.isFinite(milliseconds)) throw new Error("deploy metadata deployedAt is invalid");
  return new Date(milliseconds).toISOString();
}

function canonical(raw: unknown): string | null {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(raw))
    return null;
  const milliseconds = Date.parse(raw);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === raw ? raw : null;
}

function json(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}
function record(raw: unknown): raw is Record<string, unknown> {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw);
}
function text(raw: unknown): raw is string {
  return typeof raw === "string" && raw.length > 0;
}
function positive(raw: unknown): raw is number {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0;
}
function equal(left: unknown, right: number): boolean {
  return typeof left === "number" && Number.isFinite(left) && Math.abs(left - right) <= EPSILON;
}
function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
function decimal(values: number[]): number {
  return Number(sum(values).toFixed(12));
}

function parseArgs(argv: readonly string[]): PermanentR23LineageOptions {
  const names = [
    "ledger",
    "deploy-meta",
    "expected-sha",
    "activation-id",
    "activated-at",
    "reconciliation-grace-ms",
    "as-of",
  ];
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index],
      value = argv[index + 1],
      name = flag?.slice(2);
    if (
      !flag?.startsWith("--") ||
      value === undefined ||
      !name ||
      !names.includes(name) ||
      values[name] !== undefined
    )
      throw new Error("all readout flags are required and unique");
    values[name] = value;
  }
  if (names.some((name) => values[name] === undefined))
    throw new Error("all readout flags are required");
  return {
    ledger: values.ledger!,
    deployMeta: values["deploy-meta"]!,
    expectedSha: values["expected-sha"]!,
    activationId: values["activation-id"]!,
    activatedAt: values["activated-at"]!,
    reconciliationGraceMs: Number(values["reconciliation-grace-ms"]),
    asOf: values["as-of"]!,
  };
}

export function runCli(argv: readonly string[]): string {
  return `${JSON.stringify(analyzePermanentR23Lineages(parseArgs(argv)), null, 2)}\n`;
}

if (process.argv[1]?.endsWith("permanent-r23-lineage-readout.ts")) {
  try {
    process.stdout.write(runCli(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`ERROR ${error instanceof Error ? error.message : "readout failed"}\n`);
    process.exitCode = 1;
  }
}
