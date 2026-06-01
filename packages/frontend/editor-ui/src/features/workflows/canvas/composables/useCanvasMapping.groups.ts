import type { ExecutionStatus, IWorkflowGroup } from 'n8n-workflow';
import type { INodeUi } from '@/Interface';
import type {
	CanvasConnection,
	CanvasConnectionData,
	CanvasGroupNode,
	CanvasGroupViewState,
} from '../canvas.types';
import {
	CANVAS_NODE_GROUP_HANDLE_LEFT,
	CANVAS_NODE_GROUP_HANDLE_RIGHT,
	CANVAS_NODE_GROUP_ID_PREFIX,
	CANVAS_NODE_GROUP_TYPE,
} from '../canvas.types';
import {
	GROUP_HEADER_HEIGHT,
	GROUP_HEADER_WIDTH_COLLAPSED,
	GROUP_PADDING_X,
	GROUP_PADDING_Y_TOP,
} from '../stores/canvasNodeGroups.constants';
import { createCanvasConnectionId } from '../canvas.utils';
import { DEFAULT_NODE_SIZE, GRID_SIZE } from '@/app/utils/nodeViewUtils';
import { STICKY_NODE_TYPE } from '@/app/constants/nodeTypes';

export interface MemberRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * Size lookup for nodes that aren't the default size
 * (configurable inputs, config nodes, sticky notes).
 */
export type GetNodeDimensions = (id: string) => { width: number; height: number } | undefined;

// Sticky is the only node type whose dimensions live in parameters today.
// typeof-narrow keeps the read type-safe
function readStickyDimensions(node: INodeUi): { width: number; height: number } | undefined {
	if (node.type !== STICKY_NODE_TYPE) return undefined;
	const { width, height } = node.parameters ?? {};
	if (typeof width !== 'number' || typeof height !== 'number') return undefined;
	return { width, height };
}

// Precedence: caller-supplied → sticky parameters → DEFAULT_NODE_SIZE.
function resolveMemberDimensions(
	node: INodeUi,
	getNodeDimensions?: GetNodeDimensions,
): { width: number; height: number } {
	const supplied = getNodeDimensions?.(node.id);
	const sticky = readStickyDimensions(node);
	return {
		width: supplied?.width ?? sticky?.width ?? DEFAULT_NODE_SIZE[0],
		height: supplied?.height ?? sticky?.height ?? DEFAULT_NODE_SIZE[1],
	};
}

/**
 * Title bar position + width derived from a member rect.
 * Snaps the position to the canvas grid; if it didn't, VueFlow's
 * `snap-to-grid` would shift the title bar on the first drag.
 */
export function titleBarFromMemberRect(memberRect: MemberRect): {
	position: { x: number; y: number };
	width: number;
} {
	const snap = (v: number) => Math.round(v / GRID_SIZE) * GRID_SIZE;
	return {
		position: {
			x: snap(memberRect.x - GROUP_PADDING_X),
			y: snap(memberRect.y - GROUP_PADDING_Y_TOP - GROUP_HEADER_HEIGHT),
		},
		width: memberRect.width + 2 * GROUP_PADDING_X,
	};
}

/**
 * Bounding rect of a group's members — used to size and position the title
 * bar and frame. Reads from workflow store positions (canonical) rather than
 * VueFlow runtime, which can lag, be uninitialized, or be hidden when the
 * owning group is collapsed.
 *
 * `positionOverrides` lets the drag-time sync substitute live positions for
 * dragged members (whose store position lags until drag-stop).
 */
export function computeMemberRectFromStore(
	memberIds: string[],
	getNodeById: (id: string) => INodeUi | undefined,
	getNodeDimensions?: GetNodeDimensions,
	positionOverrides?: Map<string, { x: number; y: number }>,
): MemberRect {
	const members = memberIds
		.map((id) => getNodeById(id))
		.filter((n): n is INodeUi => n !== undefined);

	if (members.length === 0) {
		return { x: 0, y: 0, width: DEFAULT_NODE_SIZE[0], height: DEFAULT_NODE_SIZE[1] };
	}

	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;

	for (const node of members) {
		const override = positionOverrides?.get(node.id);
		const x = override?.x ?? node.position[0];
		const y = override?.y ?? node.position[1];
		const { width, height } = resolveMemberDimensions(node, getNodeDimensions);
		if (x < minX) minX = x;
		if (y < minY) minY = y;
		if (x + width > maxX) maxX = x + width;
		if (y + height > maxY) maxY = y + height;
	}

	return {
		x: minX,
		y: minY,
		width: maxX - minX,
		height: maxY - minY,
	};
}

export interface GroupAggregateInputs {
	nodeExecutionRunningById: Record<string, boolean>;
	nodeExecutionWaitingForNextById: Record<string, boolean>;
	nodeExecutionWaitingById: Record<string, string | undefined>;
	nodeHasIssuesById: Record<string, boolean>;
	nodeExecutionStatusById: Record<string, ExecutionStatus | undefined>;
	memberIterationsById: Record<string, number>;
}

/**
 * Aggregate per-member execution state into a single group-level status,
 * narrowed from `ExecutionStatus`.
 *
 * Priority mirrors the single-node CSS rule order (later rules win), so the
 * group surfaces the same dominant state a user would see on a member node:
 *   waiting > running > crashed > error > success > idle
 *
 * - `waiting`   any member is paused waiting for input (form, webhook, etc.).
 * - `running`   any member is running or queued to start next.
 * - `crashed`   any member has executionStatus 'crashed'. Surfaced
 *               distinctly so the data layer doesn't lose info; the title
 *               bar still maps it to the error visual, matching how the
 *               single-node visual treats crashed via `hasExecutionErrors`.
 * - `error`     any member has issues or executionStatus 'error'.
 *               NB: a member that errored with `onError=continue` still
 *               contributes here — that matches the single-node visual,
 *               which also flags the offending node despite the workflow
 *               succeeding overall.
 * - `success`   at least one member is 'success' and every other member is
 *               'success' or 'unknown' (didn't run — e.g. an untaken
 *               conditional branch).
 * - `undefined` (idle) otherwise. 'canceled' / 'new' / 'unknown' fall
 *               through here because the single-node visual gives them no
 *               dedicated class either.
 */
export function aggregateGroupStatus(
	memberIds: string[],
	{
		nodeExecutionRunningById,
		nodeExecutionWaitingForNextById,
		nodeExecutionWaitingById,
		nodeHasIssuesById,
		nodeExecutionStatusById,
	}: GroupAggregateInputs,
): ExecutionStatus | undefined {
	let anyWaiting = false;
	let anyRunning = false;
	let anyCrashed = false;
	let anyError = false;
	let anySuccess = false;
	let anyOther = false;

	for (const id of memberIds) {
		const status = nodeExecutionStatusById[id];

		if (nodeExecutionWaitingById[id] || status === 'waiting') {
			anyWaiting = true;
			continue;
		}
		if (nodeExecutionRunningById[id] || nodeExecutionWaitingForNextById[id]) {
			anyRunning = true;
			continue;
		}
		if (status === 'crashed') {
			anyCrashed = true;
			continue;
		}
		if (nodeHasIssuesById[id] || status === 'error') {
			anyError = true;
			continue;
		}
		if (status === 'success') {
			anySuccess = true;
		} else if (
			status !== undefined &&
			status !== 'unknown' &&
			status !== 'new' &&
			status !== 'canceled'
		) {
			anyOther = true;
		}
	}

	if (anyWaiting) return 'waiting';
	if (anyRunning) return 'running';
	if (anyCrashed) return 'crashed';
	if (anyError) return 'error';
	if (anySuccess && !anyOther) return 'success';
	return undefined;
}

/**
 * Largest per-member iteration count across the group. Used for the small
 * count badge next to the success ✓ — the badge shows the most-iterated
 * member so loop/foreach groups surface their iteration depth.
 */
export function aggregateMaxMemberIterations(
	memberIds: string[],
	memberIterationsById: Record<string, number>,
): number {
	let max = 0;
	for (const id of memberIds) {
		const iter = memberIterationsById[id] ?? 0;
		if (iter > max) max = iter;
	}
	return max;
}

export interface MapGroupsToVueFlowNodesInputs {
	allGroups: IWorkflowGroup[];
	getNodeById: (id: string) => INodeUi | undefined;
	getNodeDimensions?: GetNodeDimensions;
	isGroupCollapsed: (id: string) => boolean;
	autofocusGroupId: string | null;
	readOnly: boolean;
	aggregates: GroupAggregateInputs;
}

/**
 * Map each workflow group to a `canvas-node-group` VueFlow node (title bar + frame).
 * Members are mapped separately by `mappedNodes`.
 */
export function mapGroupsToVueFlowNodes({
	allGroups,
	getNodeById,
	getNodeDimensions,
	isGroupCollapsed,
	autofocusGroupId,
	readOnly,
	aggregates,
}: MapGroupsToVueFlowNodesInputs): CanvasGroupNode[] {
	const out: CanvasGroupNode[] = [];
	for (const group of allGroups) {
		// Skip until at least one member resolves — otherwise the rect collapses to
		// (0, 0) and lands the title bar at canvas origin. Re-emits when members arrive.
		const hasMember = group.nodeIds.some((id) => getNodeById(id) !== undefined);
		if (!hasMember) continue;

		const memberRect = computeMemberRectFromStore(group.nodeIds, getNodeById, getNodeDimensions);
		const collapsed = isGroupCollapsed(group.id);
		const data: CanvasGroupViewState = {
			group,
			memberRect,
			isCollapsed: collapsed,
			autofocusTitle: autofocusGroupId === group.id,
			executionStatus: aggregateGroupStatus(group.nodeIds, aggregates),
			maxMemberIterations: aggregateMaxMemberIterations(
				group.nodeIds,
				aggregates.memberIterationsById,
			),
		};

		const titleBar = titleBarFromMemberRect(memberRect);
		out.push({
			id: `${CANVAS_NODE_GROUP_ID_PREFIX}${group.id}`,
			type: CANVAS_NODE_GROUP_TYPE,
			position: titleBar.position,
			width: collapsed ? GROUP_HEADER_WIDTH_COLLAPSED : titleBar.width,
			height: GROUP_HEADER_HEIGHT,
			draggable: !readOnly,
			// Selectable only when the title bar represents
			// the whole group as a single visual surface
			selectable: !readOnly && collapsed,
			connectable: false,
			// Behind member nodes so the expanded frame doesn't overlap them.
			zIndex: -1,
			data,
		});
	}
	return out;
}

/**
 * Build a Map<nodeId, IWorkflowGroup> for nodes inside a collapsed group.
 * Used to look up "is this endpoint of an edge currently hidden inside a
 * collapsed group, and if so, which group does it belong to?".
 */
export function buildCollapsedGroupByNodeId(
	allGroups: IWorkflowGroup[],
	isGroupCollapsed: (id: string) => boolean,
): Map<string, IWorkflowGroup> {
	const result = new Map<string, IWorkflowGroup>();
	for (const group of allGroups) {
		if (!isGroupCollapsed(group.id)) continue;
		for (const nodeId of group.nodeIds) {
			result.set(nodeId, group);
		}
	}
	return result;
}

/**
 * Re-anchor connections crossing a collapsed group's boundary onto the
 * group's title bar (left / right handles). Edges fully inside a collapsed
 * group are dropped. Edges that converge on the same external endpoint
 * (same node + same handle) collapse into a single rendered line; status
 * is promoted on merge (running > error > pinned > success > undefined) so
 * a merged line never looks idle when something behind it isn't.
 */
const STATUS_PRIORITY: Record<NonNullable<CanvasConnectionData['status']> | 'undefined', number> = {
	running: 4,
	error: 3,
	pinned: 2,
	success: 1,
	undefined: 0,
};

function pickHigherPriorityStatus(
	a: CanvasConnectionData['status'],
	b: CanvasConnectionData['status'],
): CanvasConnectionData['status'] {
	const aKey = (a ?? 'undefined') as keyof typeof STATUS_PRIORITY;
	const bKey = (b ?? 'undefined') as keyof typeof STATUS_PRIORITY;
	return STATUS_PRIORITY[aKey] >= STATUS_PRIORITY[bKey] ? a : b;
}

export interface CanvasConnectionWithMergeFlag extends CanvasConnection {
	data?: CanvasConnectionData & { merged?: boolean };
}

export function reanchorCollapsedConnections(
	connections: CanvasConnection[],
	collapsedGroupByNodeId: Map<string, IWorkflowGroup>,
): CanvasConnectionWithMergeFlag[] {
	if (collapsedGroupByNodeId.size === 0) return connections as CanvasConnectionWithMergeFlag[];

	const byKey = new Map<string, CanvasConnectionWithMergeFlag>();
	const result: CanvasConnectionWithMergeFlag[] = [];

	for (const conn of connections) {
		const sourceGroup = collapsedGroupByNodeId.get(conn.source);
		const targetGroup = collapsedGroupByNodeId.get(conn.target);

		// Both endpoints inside the same collapsed group → drop entirely.
		if (sourceGroup && targetGroup && sourceGroup.id === targetGroup.id) {
			continue;
		}

		if (!sourceGroup && !targetGroup) {
			// External-only edge — keep as-is.
			result.push(conn);
			continue;
		}

		const sourceId = sourceGroup ? `${CANVAS_NODE_GROUP_ID_PREFIX}${sourceGroup.id}` : conn.source;
		const targetId = targetGroup ? `${CANVAS_NODE_GROUP_ID_PREFIX}${targetGroup.id}` : conn.target;
		const sourceHandle = sourceGroup ? CANVAS_NODE_GROUP_HANDLE_RIGHT : conn.sourceHandle;
		const targetHandle = targetGroup ? CANVAS_NODE_GROUP_HANDLE_LEFT : conn.targetHandle;

		const dedupeKey = `${sourceId}|${sourceHandle}|${targetId}|${targetHandle}`;
		const existing = byKey.get(dedupeKey);

		if (existing) {
			// Promote status, mark merged so the label drops out.
			existing.data = {
				...(existing.data as CanvasConnectionData),
				status: pickHigherPriorityStatus(existing.data?.status, conn.data?.status),
				merged: true,
			};
			continue;
		}

		const rewritten: CanvasConnectionWithMergeFlag = {
			...conn,
			id: createCanvasConnectionId({
				source: sourceId,
				sourceHandle,
				target: targetId,
				targetHandle,
			}),
			source: sourceId,
			target: targetId,
			sourceHandle,
			targetHandle,
		};

		byKey.set(dedupeKey, rewritten);
		result.push(rewritten);
	}

	return result;
}
