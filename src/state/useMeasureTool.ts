import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { CopcViewerState } from "./useCopcViewer";
import { autoFinishCount, MIN_POINTS, type MeasureKind, type Vec3 } from "./measure";

// L2-D: 計測ツールの操作。「いま何を測っているか（種類）」と「入力途中の点」を持ち、
// 3Dビュー（canvas）のクリックで点を足し、そろったら `viewer.addMeasurement` で新しい計測レイヤーにする。
//
// カメラ操作との分け方（クリックとドラッグの区別）:
//  - canvas の pointerdown の位置を覚え、`click` までに動いた量が小さいときだけ「クリック」とみなす。
//    ドラッグ（回転・パン）は今までどおり orbit-camera.ts が受け、こちらは何もしない。
//  - canvas のイベントは止めない（orbit-camera.ts と並んで聞くだけ）。止めるのは `dblclick` だけ:
//    面積を閉じるダブルクリックで「視点移動（寄る）」まで動かないように、capture で止める。
//  - ダブルクリックは click が2回来る。2回目（detail >= 2）は無視し、dblclick で閉じる。
//
// 点のピックは非同期（GPU から読み戻す）。クリックが速く連続しても順番が入れ替わらないよう、
// 処理は1本の Promise の列に並べて順に行う。

/** これ以上動いたらドラッグ（クリックではない）とみなす距離（CSS px）。 */
const CLICK_MOVE_TOLERANCE_PX = 5;
/** 「点がありません」などの案内を出しておく時間（ms）。 */
const NOTICE_MS = 2500;

export interface MeasureToolState {
  /** 計測中の種類。null なら計測していない（通常のカメラ操作だけ）。 */
  mode: MeasureKind | null;
  /** 入力途中の点（ワールド座標）。 */
  points: readonly Vec3[];
  /** 画面に出す短い案内（「点がありません」など）。無ければ null。 */
  notice: string | null;
  /** 計測を始める。別の種類を計測中なら、入力途中の点を捨てて切り替える。 */
  start: (kind: MeasureKind) => void;
  /** やめる（入力途中の点も捨てる）。 */
  stop: () => void;
  /** 同じ種類なら終了、違えば開始（リボンのボタン用）。 */
  toggle: (kind: MeasureKind) => void;
  /** 面積を閉じて確定する（Enter・ダブルクリックと同じ）。 */
  finish: () => void;
}

export function useMeasureTool(
  viewer: CopcViewerState,
  canvasRef: RefObject<HTMLCanvasElement | null>,
): MeasureToolState {
  const [mode, setMode] = useState<MeasureKind | null>(null);
  const [points, setPoints] = useState<readonly Vec3[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  // イベントハンドラ（canvas に付けたまま残る）から、最新の値を読むための ref。
  const modeRef = useRef<MeasureKind | null>(null);
  const pointsRef = useRef<readonly Vec3[]>([]);
  const viewerRef = useRef(viewer);
  const noticeTimerRef = useRef<number | null>(null);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  // 計測をやめたり切り替えたら増える。古い（やめる前に始めた）ピックの結果を捨てるための世代。
  const generationRef = useRef(0);

  useEffect(() => {
    viewerRef.current = viewer;
  }, [viewer]);

  const showNotice = useCallback((text: string) => {
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    setNotice(text);
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), NOTICE_MS);
  }, []);

  const setPointsBoth = useCallback((next: readonly Vec3[]) => {
    pointsRef.current = next;
    setPoints(next);
  }, []);

  const reset = useCallback(
    (nextMode: MeasureKind | null) => {
      generationRef.current += 1;
      modeRef.current = nextMode;
      setMode(nextMode);
      setPointsBoth([]);
    },
    [setPointsBoth],
  );

  const start = useCallback((kind: MeasureKind) => reset(kind), [reset]);
  const stop = useCallback(() => reset(null), [reset]);
  const toggle = useCallback((kind: MeasureKind) => reset(modeRef.current === kind ? null : kind), [reset]);

  /** いまの点で計測を確定して、新しいレイヤーにする。 */
  const commit = useCallback(
    (kind: MeasureKind, pts: readonly Vec3[]) => {
      const up = viewerRef.current.getViewSnapshot()?.up ?? [0, 0, 1];
      const len = Math.hypot(up[0], up[1], up[2]) || 1;
      viewerRef.current.addMeasurement({
        kind,
        points: pts.map((p) => [p[0], p[1], p[2]] as const),
        up: [up[0] / len, up[1] / len, up[2] / len],
      });
      setPointsBoth([]);
    },
    [setPointsBoth],
  );

  const finish = useCallback(() => {
    // 並んでいるピック（直前のクリック）が終わってから閉じる。
    const generation = generationRef.current;
    queueRef.current = queueRef.current.then(() => {
      const kind = modeRef.current;
      if (kind !== "area" || generation !== generationRef.current) return;
      if (pointsRef.current.length < MIN_POINTS.area) {
        showNotice("面積は3点以上クリックしてから閉じてください");
        return;
      }
      commit(kind, pointsRef.current);
    });
  }, [commit, showNotice]);

  /** クリック位置の点を取って、入力途中の点に足す。 */
  const addPointAt = useCallback(
    (cssX: number, cssY: number) => {
      const generation = generationRef.current;
      queueRef.current = queueRef.current.then(async () => {
        if (generation !== generationRef.current || modeRef.current === null) return;
        const picked = await viewerRef.current.pickPoint(cssX, cssY);
        // ピックの間に、計測をやめた・切り替えた場合は捨てる。
        if (generation !== generationRef.current || modeRef.current === null) return;
        if (!picked) {
          showNotice("点がありません");
          return;
        }
        const kind = modeRef.current;
        const next = [...pointsRef.current, picked.point as Vec3];
        if (next.length === autoFinishCount(kind)) {
          commit(kind, next);
        } else {
          setPointsBoth(next);
        }
      });
    },
    [commit, setPointsBoth, showNotice],
  );

  // 計測中だけ、canvas のクリック・ダブルクリックと、キーボード（Esc・Enter）を聞く。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (mode === null || !canvas) return;

    let down: { x: number; y: number; id: number } | null = null;
    const onPointerDown = (e: PointerEvent) => {
      // 左ボタン（タッチ・ペンの接触を含む）だけ。2本目の指（ピンチ）は無視する。
      if (e.button !== 0 || !e.isPrimary) {
        down = null;
        return;
      }
      down = { x: e.clientX, y: e.clientY, id: e.pointerId };
    };
    const onClick = (e: MouseEvent) => {
      const start = down;
      down = null;
      if (!start) return;
      // 動かしてから離した = ドラッグ。カメラ操作に任せる。
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > CLICK_MOVE_TOLERANCE_PX) return;
      // ダブルクリックの2回目は無視する（閉じるのは dblclick）。
      if (e.detail >= 2) return;
      const rect = canvas.getBoundingClientRect();
      addPointAt(e.clientX - rect.left, e.clientY - rect.top);
    };
    const onDoubleClick = (e: MouseEvent) => {
      // 視点移動（ダブルクリックで寄る）を動かさない。
      e.stopImmediatePropagation();
      finish();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target;
      if (target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (e.key === "Escape") {
        reset(null);
      } else if (e.key === "Enter") {
        finish();
      }
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("click", onClick);
    // capture: orbit-camera.ts の dblclick より先に受けて止める。
    canvas.addEventListener("dblclick", onDoubleClick, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("click", onClick);
      canvas.removeEventListener("dblclick", onDoubleClick, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [mode, canvasRef, addPointAt, finish, reset]);

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    };
  }, []);

  return { mode, points, notice, start, stop, toggle, finish };
}
