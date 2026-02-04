"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

type Status =
  | { kind: "idle"; message?: string }
  | { kind: "loading"; message: string }
  | { kind: "ready"; message?: string }
  | { kind: "error"; message: string };

type Mode = "WL" | "PAN" | "MEASURE";

type MeasureState =
  | { stage: "off" }
  | {
      stage: "one";
      p1Image: { x: number; y: number };
    }
  | {
      stage: "two";
      p1Image: { x: number; y: number };
      p2Image: { x: number; y: number };
      distancePx: number;
      distanceMm?: number;
    };

export default function DicomViewer() {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [fileName, setFileName] = useState<string>("");
  const [info, setInfo] = useState<{
    rows?: number;
    cols?: number;
    frames?: number;
    pixelSpacingMm?: { row: number; col: number } | null;
  } | null>(null);

  const [mode, setMode] = useState<Mode>("WL");

  const [baseImageId, setBaseImageId] = useState<string | null>(null);
  const [frameCount, setFrameCount] = useState<number>(1);
  const [frameIndex, setFrameIndex] = useState<number>(0);

  const [isDraggingOver, setIsDraggingOver] = useState<boolean>(false);

  // Nice-to-haves
  const [invert, setInvert] = useState(false);
  const [hflip, setHflip] = useState(false);
  const [vflip, setVflip] = useState(false);
  const [rotation, setRotation] = useState(0); // degrees 0/90/180/270

  // Measurement
  const [measure, setMeasure] = useState<MeasureState>({ stage: "off" });

  // Cine
  const [cinePlaying, setCinePlaying] = useState(false);
  const [cineFps, setCineFps] = useState(10);
  const cineTimerRef = useRef<number | null>(null);

  // Lazy-loaded libs (client only)
  const libsRef = useRef<{
    cornerstone?: any;
    dicomParser?: any;
    wadoImageLoader?: any;
  }>({});

  const isReady = useMemo(() => status.kind === "ready", [status.kind]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        setStatus({ kind: "loading", message: "Loading viewer..." });

        const cornerstone = (await import("cornerstone-core")).default;
        const dicomParser = (await import("dicom-parser")).default;
        const wadoImageLoader = (await import("cornerstone-wado-image-loader")).default;

        wadoImageLoader.external.cornerstone = cornerstone;
        wadoImageLoader.external.dicomParser = dicomParser;

        wadoImageLoader.configure({ useWebWorkers: true });

        libsRef.current = { cornerstone, dicomParser, wadoImageLoader };

        if (!cancelled) setStatus({ kind: "idle" });
      } catch (e: any) {
        if (!cancelled) {
          setStatus({
            kind: "error",
            message:
              "Failed to load viewer libraries. " + (e?.message ? `(${e.message})` : ""),
          });
        }
      }
    })();

    return () => {
      cancelled = true;
      stopCine();

      const { cornerstone } = libsRef.current;
      if (cornerstone && elementRef.current) {
        try {
          cornerstone.disable(elementRef.current);
        } catch {}
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep overlay canvas in sync with size
  useEffect(() => {
    const el = elementRef.current;
    const canvas = overlayCanvasRef.current;
    if (!el || !canvas) return;

    const resize = () => {
      const rect = el.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(rect.width));
      canvas.height = Math.max(1, Math.floor(rect.height));
      redrawOverlay();
    };

    resize();

    const ro = new ResizeObserver(resize);
    ro.observe(el);

    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measure, status.kind, invert, hflip, vflip, rotation, frameIndex]);

  // Apply viewport toggles whenever they change
  useEffect(() => {
    if (!isReady) return;
    applyViewportTransforms();
    redrawOverlay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invert, hflip, vflip, rotation, isReady]);

  // Stop cine if you load a different file or frames change
  useEffect(() => {
    stopCine();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseImageId]);

  const ensureEnabled = () => {
    const { cornerstone } = libsRef.current;
    const el = elementRef.current;
    if (!cornerstone || !el) return false;

    try {
      try {
        cornerstone.getEnabledElement(el);
      } catch {
        cornerstone.enable(el);
      }
      return true;
    } catch {
      return false;
    }
  };

  const getViewportSafe = () => {
    const { cornerstone } = libsRef.current;
    const el = elementRef.current;
    if (!cornerstone || !el) return null;
    try {
      return cornerstone.getViewport(el);
    } catch {
      return null;
    }
  };

  const setViewportSafe = (viewport: any) => {
    const { cornerstone } = libsRef.current;
    const el = elementRef.current;
    if (!cornerstone || !el) return;
    try {
      cornerstone.setViewport(el, viewport);
    } catch {}
  };

  const applyViewportTransforms = () => {
    const vp = getViewportSafe();
    if (!vp) return;

    vp.invert = invert;
    vp.hflip = hflip;
    vp.vflip = vflip;
    vp.rotation = rotation;

    setViewportSafe(vp);
  };

  const fitToScreen = () => {
    const { cornerstone } = libsRef.current;
    const el = elementRef.current;
    if (!cornerstone || !el) return;
    try {
      cornerstone.fitToWindow(el);
      redrawOverlay();
    } catch {
      resetViewport();
    }
  };

  const resetViewport = () => {
    const { cornerstone } = libsRef.current;
    const el = elementRef.current;
    if (!cornerstone || !el) return;

    try {
      const image = cornerstone.getImage(el);
      const viewport = cornerstone.getDefaultViewportForImage(el, image);
      cornerstone.setViewport(el, viewport);
      redrawOverlay();
    } catch {}
  };

  const zoomByFactor = (factor: number) => {
    const vp = getViewportSafe();
    if (!vp) return;
    vp.scale = clamp(vp.scale * factor, 0.05, 30);
    setViewportSafe(vp);
    redrawOverlay();
  };

  const panBy = (dx: number, dy: number) => {
    const vp = getViewportSafe();
    if (!vp) return;
    vp.translation = {
      x: (vp.translation?.x ?? 0) + dx,
      y: (vp.translation?.y ?? 0) + dy,
    };
    setViewportSafe(vp);
    redrawOverlay();
  };

  const adjustWlBy = (dx: number, dy: number) => {
    const vp = getViewportSafe();
    if (!vp) return;

    const ww0 = vp.voi?.windowWidth ?? 1;
    const wc0 = vp.voi?.windowCenter ?? 0;

    // dx affects WW, dy affects WC (common feel)
    const ww = clamp(ww0 + dx * 2, 1, 65535);
    const wc = clamp(wc0 + dy * 2, -65535, 65535);

    vp.voi = { windowWidth: ww, windowCenter: wc };
    setViewportSafe(vp);
    redrawOverlay();
  };

  const displayFrame = async (baseId: string, idx: number, shouldFit = false) => {
    const { cornerstone } = libsRef.current;
    const el = elementRef.current;
    if (!cornerstone || !el) return;

    const imageId = idx > 0 ? `${baseId}?frame=${idx}` : baseId;
    const image = await cornerstone.loadAndCacheImage(imageId);
    cornerstone.displayImage(el, image);

    // Re-apply transforms after display
    applyViewportTransforms();

    if (shouldFit) {
      try {
        cornerstone.fitToWindow(el);
      } catch {}
    }
    redrawOverlay();
  };

  const stopCine = () => {
    if (cineTimerRef.current) {
      window.clearInterval(cineTimerRef.current);
      cineTimerRef.current = null;
    }
    setCinePlaying(false);
  };

  const startCine = () => {
    if (!baseImageId || frameCount <= 1) return;
    stopCine();
    setCinePlaying(true);

    const intervalMs = clamp(Math.floor(1000 / clamp(cineFps, 1, 60)), 16, 1000);
    cineTimerRef.current = window.setInterval(() => {
      setFrameIndex((prev) => (prev + 1) % frameCount);
    }, intervalMs);
  };

  useEffect(() => {
    if (!cinePlaying) return;
    startCine();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cineFps]);

  const clientToImagePoint = (clientX: number, clientY: number) => {
    const { cornerstone } = libsRef.current;
    const el = elementRef.current;
    if (!cornerstone || !el) return null;
    try {
      const rect = el.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      const pt = cornerstone.pageToPixel(el, rect.left + x, rect.top + y);
      return { x: pt.x, y: pt.y };
    } catch {
      return null;
    }
  };

  const imageToCanvasPoint = (imageX: number, imageY: number) => {
    const { cornerstone } = libsRef.current;
    const el = elementRef.current;
    const canvas = overlayCanvasRef.current;
    if (!cornerstone || !el || !canvas) return null;
    try {
      const pt = cornerstone.pixelToCanvas(el, { x: imageX, y: imageY });
      return { x: pt.x, y: pt.y };
    } catch {
      return null;
    }
  };

  const computeDistance = (p1: { x: number; y: number }, p2: { x: number; y: number }) => {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const px = Math.sqrt(dx * dx + dy * dy);

    let mm: number | undefined;
    const spacing = info?.pixelSpacingMm;
    if (spacing?.row && spacing?.col) {
      // Approx using average spacing (good enough for a simple viewer)
      const avg = (spacing.row + spacing.col) / 2;
      mm = px * avg;
    }

    return { px, mm };
  };

  const redrawOverlay = () => {
    const canvas = overlayCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (status.kind !== "ready") return;

    if (measure.stage === "one" || measure.stage === "two") {
      const p1c = imageToCanvasPoint(measure.p1Image.x, measure.p1Image.y);
      if (!p1c) return;

      // Draw point 1
      ctx.save();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.beginPath();
      ctx.arc(p1c.x, p1c.y, 4, 0, Math.PI * 2);
      ctx.fill();

      if (measure.stage === "two") {
        const p2c = imageToCanvasPoint(measure.p2Image.x, measure.p2Image.y);
        if (!p2c) {
          ctx.restore();
          return;
        }

        // Draw point 2
        ctx.beginPath();
        ctx.arc(p2c.x, p2c.y, 4, 0, Math.PI * 2);
        ctx.fill();

        // Draw line
        ctx.beginPath();
        ctx.moveTo(p1c.x, p1c.y);
        ctx.lineTo(p2c.x, p2c.y);
        ctx.stroke();

        // Label
        const label =
          measure.distanceMm != null
            ? `${measure.distancePx.toFixed(1)} px • ${measure.distanceMm.toFixed(1)} mm`
            : `${measure.distancePx.toFixed(1)} px`;

        const midX = (p1c.x + p2c.x) / 2;
        const midY = (p1c.y + p2c.y) / 2;

        ctx.font = "12px system-ui, -apple-system, Segoe UI, Roboto, Arial";
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";

        // Text shadow-ish background
        ctx.fillStyle = "rgba(0,0,0,0.65)";
        const padX = 8;
        const padY = 6;
        const textW = ctx.measureText(label).width;
        ctx.fillRect(midX - textW / 2 - padX, midY - 18 - padY, textW + padX * 2, 18);

        ctx.fillStyle = "rgba(255,255,255,0.92)";
        ctx.fillText(label, midX, midY - 6);
      }

      ctx.restore();
    }
  };

  const loadDicomFile = async (file: File) => {
    const { wadoImageLoader, dicomParser } = libsRef.current;
    if (!wadoImageLoader || !dicomParser) {
      setStatus({ kind: "error", message: "Viewer not ready yet. Try again in a second." });
      return;
    }

    setFileName(file.name);
    setInfo(null);
    setStatus({ kind: "loading", message: "Reading DICOM..." });

    setFrameIndex(0);
    setFrameCount(1);
    setBaseImageId(null);

    // Reset nice-to-haves
    stopCine();
    setInvert(false);
    setHflip(false);
    setVflip(false);
    setRotation(0);
    setMeasure({ stage: "off" });

    try {
      if (!ensureEnabled()) {
        setStatus({ kind: "error", message: "Could not initialize viewer." });
        return;
      }

      const imageId = wadoImageLoader.wadouri.fileManager.add(file);
      setBaseImageId(imageId);

      // Parse metadata for frames + pixel spacing
      let rows: number | undefined;
      let cols: number | undefined;
      let frames = 1;
      let pixelSpacingMm: { row: number; col: number } | null = null;

      try {
        const buffer = await file.arrayBuffer();
        const byteArray = new Uint8Array(buffer);
        const dataSet = dicomParser.parseDicom(byteArray);

        rows = dataSet.uint16("x00280010") ?? undefined;
        cols = dataSet.uint16("x00280011") ?? undefined;

        const framesStr = dataSet.string("x00280008");
        const parsedFrames = framesStr ? parseInt(framesStr, 10) : NaN;
        if (Number.isFinite(parsedFrames) && parsedFrames > 1) frames = parsedFrames;

        // Pixel Spacing (0028,0030): "row\col" (mm)
        const ps = dataSet.string("x00280030");
        if (ps) {
          const parts = ps.split("\\").map((s) => parseFloat(s));
          if (parts.length >= 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
            pixelSpacingMm = { row: parts[0], col: parts[1] };
          }
        }

        setInfo({ rows, cols, frames, pixelSpacingMm });
      } catch {
        setInfo(null);
      }

      setFrameCount(frames);

      await displayFrame(imageId, 0, true);

      setStatus({ kind: "ready" });
    } catch (err: any) {
      setStatus({
        kind: "error",
        message:
          "Could not open this file as a viewable DICOM image. " +
          "It may be compressed with an unsupported transfer syntax, be non-image DICOM, or require additional codecs. " +
          (err?.message ? `(${err.message})` : ""),
      });
    }
  };

  const onPickFile: React.ChangeEventHandler<HTMLInputElement> = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await loadDicomFile(file);
  };

  // Multi-frame display when slider changes
  useEffect(() => {
    (async () => {
      if (!isReady) return;
      if (!baseImageId) return;
      try {
        await displayFrame(baseImageId, frameIndex, false);
      } catch (e: any) {
        setStatus({
          kind: "error",
          message: "Failed to load selected frame. " + (e?.message ? `(${e.message})` : ""),
        });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameIndex]);

  // Drag & drop handlers
  const onDragOver: React.DragEventHandler<HTMLDivElement> = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(true);
  };
  const onDragLeave: React.DragEventHandler<HTMLDivElement> = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);
  };
  const onDrop: React.DragEventHandler<HTMLDivElement> = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);

    const file = e.dataTransfer.files?.[0];
    if (!file) return;

    await loadDicomFile(file);
  };

  // Mouse interactions
  const onWheel: React.WheelEventHandler<HTMLDivElement> = (ev) => {
    if (status.kind !== "ready") return;
    ev.preventDefault();
    zoomByFactor(ev.deltaY > 0 ? 0.9 : 1.1);
  };

  const onMouseDown: React.MouseEventHandler<HTMLDivElement> = (ev) => {
    if (status.kind !== "ready") return;

    ev.preventDefault();

    // Measurement click logic (mouse)
    if (mode === "MEASURE") {
      const p = clientToImagePoint(ev.clientX, ev.clientY);
      if (!p) return;

      if (measure.stage === "off" || measure.stage === "two") {
        setMeasure({ stage: "one", p1Image: p });
      } else if (measure.stage === "one") {
        const dist = computeDistance(measure.p1Image, p);
        setMeasure({
          stage: "two",
          p1Image: measure.p1Image,
          p2Image: p,
          distancePx: dist.px,
          distanceMm: dist.mm,
        });
      }
      // redraw occurs via state effects
      return;
    }

    const startX = ev.clientX;
    const startY = ev.clientY;

    let raf = 0;
    let latestDX = 0;
    let latestDY = 0;

    const apply = () => {
      raf = 0;
      if (mode === "PAN") {
        panBy(latestDX, latestDY);
      } else {
        adjustWlBy(latestDX, latestDY);
      }
    };

    const onMove = (moveEv: MouseEvent) => {
      latestDX = moveEv.clientX - startX;
      latestDY = moveEv.clientY - startY;
      if (!raf) raf = window.requestAnimationFrame(apply);
    };

    const onUp = () => {
      if (raf) window.cancelAnimationFrame(raf);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Touch gestures:
  // - 1 finger: WL or PAN or MEASURE (tap to set points)
  // - 2 fingers: pinch zoom + pan
  const lastTapRef = useRef<number>(0);
  const touchStateRef = useRef<{
    kind: "none" | "one" | "two";
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    // two-finger
    startDist: number;
    lastDist: number;
    lastCenterX: number;
    lastCenterY: number;
  }>({
    kind: "none",
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    startDist: 0,
    lastDist: 0,
    lastCenterX: 0,
    lastCenterY: 0,
  });

  const onTouchStart: React.TouchEventHandler<HTMLDivElement> = (e) => {
    if (status.kind !== "ready") return;

    // Double tap to fit
    const now = Date.now();
    if (e.touches.length === 1) {
      const dt = now - lastTapRef.current;
      lastTapRef.current = now;
      if (dt < 300) {
        fitToScreen();
        return;
      }
    }

    if (e.touches.length === 1) {
      const t = e.touches[0];
      touchStateRef.current = {
        ...touchStateRef.current,
        kind: "one",
        startX: t.clientX,
        startY: t.clientY,
        lastX: t.clientX,
        lastY: t.clientY,
      };
    } else if (e.touches.length === 2) {
      const a = e.touches[0];
      const b = e.touches[1];
      const cx = (a.clientX + b.clientX) / 2;
      const cy = (a.clientY + b.clientY) / 2;
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

      touchStateRef.current = {
        ...touchStateRef.current,
        kind: "two",
        startDist: dist,
        lastDist: dist,
        lastCenterX: cx,
        lastCenterY: cy,
      };
    }
  };

  const onTouchMove: React.TouchEventHandler<HTMLDivElement> = (e) => {
    if (status.kind !== "ready") return;
    e.preventDefault();

    if (e.touches.length === 1 && touchStateRef.current.kind === "one") {
      const t = e.touches[0];
      const dx = t.clientX - touchStateRef.current.lastX;
      const dy = t.clientY - touchStateRef.current.lastY;

      touchStateRef.current.lastX = t.clientX;
      touchStateRef.current.lastY = t.clientY;

      if (mode === "PAN") {
        panBy(dx, dy);
      } else if (mode === "WL") {
        adjustWlBy(dx, dy);
      }
      // MEASURE: movement does nothing (tap sets points)
    } else if (e.touches.length === 2) {
      const a = e.touches[0];
      const b = e.touches[1];
      const cx = (a.clientX + b.clientX) / 2;
      const cy = (a.clientY + b.clientY) / 2;
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

      const prev = touchStateRef.current;
      const distRatio = dist / (prev.lastDist || dist);

      // Zoom
      if (Number.isFinite(distRatio) && distRatio !== 1) {
        zoomByFactor(distRatio);
      }

      // Pan by center movement
      const dx = cx - prev.lastCenterX;
      const dy = cy - prev.lastCenterY;
      if (dx || dy) panBy(dx, dy);

      touchStateRef.current.lastDist = dist;
      touchStateRef.current.lastCenterX = cx;
      touchStateRef.current.lastCenterY = cy;
    }
  };

  const onTouchEnd: React.TouchEventHandler<HTMLDivElement> = (e) => {
    if (status.kind !== "ready") return;

    // If MEASURE mode and a tap ended with 0 movement, set point
    if (mode === "MEASURE" && e.changedTouches.length >= 1) {
      const t = e.changedTouches[0];
      const p = clientToImagePoint(t.clientX, t.clientY);
      if (!p) return;

      if (measure.stage === "off" || measure.stage === "two") {
        setMeasure({ stage: "one", p1Image: p });
      } else if (measure.stage === "one") {
        const dist = computeDistance(measure.p1Image, p);
        setMeasure({
          stage: "two",
          p1Image: measure.p1Image,
          p2Image: p,
          distancePx: dist.px,
          distanceMm: dist.mm,
        });
      }
    }

    // Reset touch kind
    touchStateRef.current.kind = "none";
  };

  const clearMeasure = () => setMeasure({ stage: "off" });

  return (
    <section
      style={{
        display: "grid",
        gridTemplateColumns: "420px 1fr",
        gap: 16,
        alignItems: "start",
      }}
    >
      {/* Left panel */}
      <div
        style={{
          border: "1px solid rgba(255,255,255,0.15)",
          borderRadius: 12,
          padding: 16,
          background: "rgba(255,255,255,0.03)",
        }}
      >
        <label style={{ display: "block", fontWeight: 900, marginBottom: 8 }}>
          Upload DICOM (.dcm)
        </label>

        <input
          type="file"
          accept=".dcm,application/dicom,application/octet-stream"
          onChange={onPickFile}
          style={inputStyle}
        />

        <div style={{ marginTop: 12, fontSize: 14, opacity: 0.92, lineHeight: 1.45 }}>
          <div>
            <strong>Status:</strong>{" "}
            {status.kind === "loading"
              ? status.message
              : status.kind === "error"
              ? "Error"
              : "Ready"}
          </div>

          {status.kind === "error" ? (
            <div style={{ marginTop: 8, color: "rgba(255,170,170,0.95)" }}>
              {status.message}
            </div>
          ) : null}

          {fileName ? (
            <div style={{ marginTop: 8 }}>
              <strong>File:</strong> {fileName}
            </div>
          ) : null}

          {info?.rows && info?.cols ? (
            <div style={{ marginTop: 6 }}>
              <strong>Size:</strong> {info.cols} × {info.rows}
            </div>
          ) : null}

          {info?.pixelSpacingMm ? (
            <div style={{ marginTop: 6 }}>
              <strong>Pixel spacing:</strong> {info.pixelSpacingMm.row} × {info.pixelSpacingMm.col} mm
            </div>
          ) : null}

          {frameCount > 1 ? (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontWeight: 900, marginBottom: 6 }}>
                Frame: {frameIndex + 1} / {frameCount}
              </div>
              <input
                type="range"
                min={0}
                max={frameCount - 1}
                value={frameIndex}
                onChange={(e) => setFrameIndex(parseInt(e.target.value, 10))}
                style={{ width: "100%" }}
                disabled={!isReady || cinePlaying}
              />
            </div>
          ) : null}
        </div>

        {/* Drag mode */}
        <div style={{ marginTop: 14 }}>
          <div style={{ fontWeight: 900, marginBottom: 8 }}>Drag Mode</div>
          <div style={{ display: "flex", gap: 10 }}>
            <button type="button" onClick={() => setMode("WL")} style={pillStyle(mode === "WL")}>
              Bright / Contrast
            </button>
            <button type="button" onClick={() => setMode("PAN")} style={pillStyle(mode === "PAN")}>
              Pan
            </button>
            <button
              type="button"
              onClick={() => {
                setMode("MEASURE");
                // Keep last measurement visible; user can clear if desired
              }}
              style={pillStyle(mode === "MEASURE")}
            >
              Measure
            </button>
          </div>

          {mode === "MEASURE" ? (
            <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button type="button" onClick={clearMeasure} style={buttonStyle(false)}>
                Clear Measure
              </button>
              <div style={{ fontSize: 12, opacity: 0.75, alignSelf: "center" }}>
                Tap/click 2 points to measure
              </div>
            </div>
          ) : null}
        </div>

        {/* Image tools */}
        <div style={{ marginTop: 14 }}>
          <div style={{ fontWeight: 900, marginBottom: 8 }}>Tools</div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => setInvert((v) => !v)}
              disabled={!isReady}
              style={buttonStyle(!isReady)}
            >
              {invert ? "Invert: On" : "Invert: Off"}
            </button>

            <button
              type="button"
              onClick={() => setRotation((r) => (r + 90) % 360)}
              disabled={!isReady}
              style={buttonStyle(!isReady)}
            >
              Rotate 90°
            </button>

            <button
              type="button"
              onClick={() => setHflip((v) => !v)}
              disabled={!isReady}
              style={buttonStyle(!isReady)}
            >
              Flip H
            </button>

            <button
              type="button"
              onClick={() => setVflip((v) => !v)}
              disabled={!isReady}
              style={buttonStyle(!isReady)}
            >
              Flip V
            </button>
          </div>
        </div>

        {/* Cine */}
        {frameCount > 1 ? (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontWeight: 900, marginBottom: 8 }}>Cine</div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              {!cinePlaying ? (
                <button
                  type="button"
                  onClick={startCine}
                  disabled={!isReady}
                  style={buttonStyle(!isReady)}
                >
                  Play
                </button>
              ) : (
                <button type="button" onClick={stopCine} style={buttonStyle(false)}>
                  Stop
                </button>
              )}

              <div style={{ fontSize: 13, opacity: 0.85 }}>
                FPS: <strong>{cineFps}</strong>
              </div>

              <input
                type="range"
                min={1}
                max={30}
                value={cineFps}
                onChange={(e) => setCineFps(parseInt(e.target.value, 10))}
                style={{ width: 160 }}
                disabled={!isReady}
              />
            </div>
          </div>
        ) : null}

        {/* View controls */}
        <div style={{ marginTop: 14, display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button type="button" onClick={fitToScreen} disabled={!isReady} style={buttonStyle(!isReady)}>
            Fit to Screen
          </button>
          <button type="button" onClick={resetViewport} disabled={!isReady} style={buttonStyle(!isReady)}>
            Reset View
          </button>
          <button
            type="button"
            onClick={() => {
              alert(
                "Controls:\n\nDesktop:\n• Wheel: zoom\n• Drag (WL): brightness/contrast\n• Drag (Pan): move\n• Measure: click 2 points\n\nMobile:\n• 1-finger drag: WL or Pan (depending on mode)\n• 2-finger pinch: zoom\n• 2-finger move: pan\n• Double tap: fit to screen\n\nDrag & drop a .dcm onto the viewer too."
              );
            }}
            style={buttonStyle(false)}
          >
            Controls
          </button>
        </div>

        <p style={{ marginTop: 14, fontSize: 12, opacity: 0.7 }}>
          Note: Some compressed DICOMs still may not render without extra codecs. This viewer is designed to be simple,
          fast, and fully in-browser.
        </p>
      </div>

      {/* Viewer */}
      <div
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        style={{
          border: "1px solid rgba(255,255,255,0.15)",
          borderRadius: 12,
          overflow: "hidden",
          background: "#000",
          minHeight: 600,
          position: "relative",
          outline: isDraggingOver ? "2px solid rgba(255,255,255,0.35)" : "none",
        }}
      >
        <div
          ref={elementRef}
          style={{
            width: "100%",
            height: 600,
            background: "#000",
            touchAction: "none",
            cursor:
              status.kind === "ready"
                ? mode === "WL"
                  ? "crosshair"
                  : mode === "PAN"
                  ? "grab"
                  : "crosshair"
                : "default",
          }}
          onWheel={onWheel}
          onMouseDown={onMouseDown}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
        />

        {/* Overlay canvas for measurement */}
        <canvas
          ref={overlayCanvasRef}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            pointerEvents: "none",
          }}
        />

        {/* Overlay messages */}
        {status.kind !== "ready" ? (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "grid",
              placeItems: "center",
              padding: 18,
              textAlign: "center",
              pointerEvents: "none",
              color: "rgba(255,255,255,0.75)",
            }}
          >
            <div>
              <div style={{ fontSize: 16, fontWeight: 900, marginBottom: 6 }}>
                {status.kind === "loading"
                  ? status.message
                  : status.kind === "error"
                  ? "Viewer Error"
                  : isDraggingOver
                  ? "Drop your DICOM here"
                  : "Upload or drop a DICOM to view it"}
              </div>
              <div style={{ fontSize: 13, opacity: 0.85 }}>
                {status.kind === "error"
                  ? "Try a different DICOM if this one is compressed or unsupported."
                  : "Rendering is local in your browser on a black background."}
              </div>
            </div>
          </div>
        ) : isDraggingOver ? (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "grid",
              placeItems: "center",
              padding: 18,
              textAlign: "center",
              pointerEvents: "none",
              background: "rgba(255,255,255,0.05)",
              color: "rgba(255,255,255,0.9)",
            }}
          >
            <div style={{ fontSize: 18, fontWeight: 950 }}>Drop your DICOM here</div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: 10,
  borderRadius: 10,
  border: "1px solid rgba(255,255,255,0.2)",
  background: "#000",
  color: "#fff",
};

function buttonStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: "10px 12px",
    borderRadius: 10,
    border: "1px solid rgba(255,255,255,0.2)",
    background: disabled ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.12)",
    color: "#fff",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.6 : 1,
    fontWeight: 900,
  };
}

function pillStyle(active: boolean): React.CSSProperties {
  return {
    padding: "10px 12px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,0.2)",
    background: active ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.08)",
    color: "#fff",
    cursor: "pointer",
    fontWeight: 950,
    flex: 1,
  };
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}
