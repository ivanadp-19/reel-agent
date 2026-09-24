import React from 'react';
import {Sequence, OffthreadVideo, Video, Img, staticFile, useVideoConfig, interpolate, useCurrentFrame, getRemotionEnvironment} from 'remotion';
import {layoutBoxes, useActiveLayout} from './Graphics';
import type {Graphic} from './graphicTemplates';

export {projectBrolls} from './brollModel';
export type {BrollItem, BrollAsset} from './brollModel';
import type {BrollItem} from './brollModel';
import {transitionFx} from './transitions';
import {cardLanding, ms} from './motion';

// remote (Pexels) URLs load directly; local paths go through staticFile
const resolveSrc = (s: string) => (/^https?:\/\//.test(s) ? s : staticFile(s));

const boxByMode: Record<BrollItem['mode'], React.CSSProperties> = {
  fullscreen: {top: 0, left: 0, width: '100%', height: '100%'},
  top: {top: 0, left: 0, width: '100%', height: '45%'},
  inset: {top: '6%', right: '5%', width: '34%', height: '22%', borderRadius: 18, overflow: 'hidden', border: '3px solid rgba(255,255,255,0.9)', boxShadow: '0 20px 50px rgba(0,0,0,0.5)'},
  // Prism Pro: a square card, 80 % wide, centred a touch above the middle, over the blurred footage
  card: {top: '28%', left: '10%', width: '80%', height: '45%', overflow: 'hidden', boxShadow: '0 30px 80px rgba(0,0,0,0.35)'},
};
const CARD_EXIT_MS = 500; // it leaves upwards, accelerating (12 f at 24 fps)

const One: React.FC<{item: BrollItem; panel?: {top: number; left: number; width: number; height: number} | null}> = ({item, panel}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const fade = interpolate(frame, [0, Math.round(fps * 0.18)], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  // a split layout owns the B-roll: it fills the panel, whatever the cue's mode
  const box: React.CSSProperties = panel
    ? {top: `${panel.top}%`, left: `${panel.left}%`, width: `${panel.width}%`, height: `${panel.height}%`, borderRadius: 36, overflow: 'hidden'}
    : boxByMode[item.mode] ?? boxByMode.fullscreen;
  const VideoComp = getRemotionEnvironment().isRendering ? OffthreadVideo : Video;
  const src = resolveSrc(item.src);
  const scale = item.scale ?? 1;
  // entry transition (whip / zoom / punch) on the cue itself, like a clip's
  const fx = item.enter && item.enter !== 'cut' ? transitionFx({id: item.id, src: item.src, inSec: 0, outSec: 0, sourceDurationSec: 0, enter: item.enter}, frame, 1e6) : null;
  const moving = fx && (fx.scale !== 1 || fx.dx !== 0 || fx.blur > 0);
  // scale around a sensible origin per mode (inset hugs its corner, others center)
  const origin = item.mode === 'inset' ? 'top right' : 'center';
  // card: rises fast then drifts up for a long landing, and leaves upwards accelerating over its last frames
  const card = item.mode === 'card' && !panel;
  const dur = Math.max(1, Math.round(((item.endMs - item.startMs) / 1000) * fps));
  const exitT = card ? Math.min(1, Math.max(0, 1 - (dur - 1 - frame) / ms(fps, CARD_EXIT_MS))) : 0;
  const cardY = card ? (1 - cardLanding(frame, fps)) * 900 - exitT * exitT * 1500 : 0;
  const move = [scale === 1 ? '' : `scale(${scale})`, card ? `translateY(${cardY.toFixed(1)}px)` : ''].filter(Boolean).join(' ');

  return (
    <div data-ab={`broll:${item.id}`} style={{position: 'absolute', ...box, opacity: moving || card ? 1 : fade, transform: move || undefined, transformOrigin: origin}}>
      <div style={{width: '100%', height: '100%', transformOrigin: '50% 38%', transform: moving ? `translateX(${fx.dx}%) scale(${fx.scale})` : undefined, filter: moving && fx.blur > 0.2 ? `blur(${fx.blur.toFixed(1)}px)` : undefined}}>
        {item.kind === 'video' ? (
          <VideoComp src={src} muted style={{width: '100%', height: '100%', objectFit: 'cover'}} />
        ) : (
          <Img src={src} style={{width: '100%', height: '100%', objectFit: 'cover'}} />
        )}
      </div>
    </div>
  );
};

export const BrollLayer: React.FC<{items: BrollItem[]; layouts?: Graphic[]}> = ({items, layouts = []}) => {
  const {fps} = useVideoConfig();
  const active = useActiveLayout(layouts);
  const panel = active ? layoutBoxes(active.props).panel : null;
  if (!items?.length) return null;
  return (
    <>
      {items.map((b) => {
        const from = Math.round((b.startMs / 1000) * fps);
        const dur = Math.max(1, Math.round(((b.endMs - b.startMs) / 1000) * fps));
        return (
          <Sequence key={b.id} from={from} durationInFrames={dur} layout="none" name={`broll: ${b.query ?? b.id}`}>
            <One item={b} panel={panel} />
          </Sequence>
        );
      })}
    </>
  );
};
