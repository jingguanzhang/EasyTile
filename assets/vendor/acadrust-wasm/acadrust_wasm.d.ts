/* tslint:disable */
/* eslint-disable */

/**
 * JS 接口修订号。
 */
export function abiVersion(): number;

/**
 * 内置 acadrust 版本，便于追溯构建。
 */
export function acadrustVersion(): string;

/**
 * 由 JSON 绘图描述直接生成图纸（TileCalc 扩展）。
 *
 * `spec_json` 结构见 `builder` 模块说明；`to_dwg` 为 true 时写出 DWG，否则写出 DXF；
 * `version_code` 为 DXF 版本号 (如 1032 = AutoCAD 2018，0 = 默认 AC1032)。
 */
export function buildDrawing(spec_json: string, to_dwg: boolean, version_code: number): Uint8Array;

/**
 * DXF → DWG（读入现有 DXF 后整体写成 DWG；工作站导出已改为 `buildDrawing` 直接写 DWG）。
 */
export function dxfToDwg(data: Uint8Array, version_code: number): Uint8Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly abiVersion: () => number;
    readonly acadrustVersion: () => [number, number];
    readonly buildDrawing: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly dxfToDwg: (a: number, b: number, c: number) => [number, number, number, number];
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
