import React from 'react';
import {Composition, staticFile} from 'remotion';
import {MultiClipVideo} from './MultiClipVideo';
import {totalDurationFrames} from './timeline';

// The editor renders MultiClipVideo via @remotion/player; this composition is
// what `remotion render` exports. Props come straight from the editor on export;
// in Studio they fall back to the files on disk.
export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="MultiClip"
      component={MultiClipVideo}
      durationInFrames={300}
      fps={30}
      width={1080}
      height={1920}
      defaultProps={{clips: [], music: null, captions: [], brolls: [], accentColor: '#FFB020', captionStyle: 'palabra'}}
      calculateMetadata={async ({props}) => {
        const fps = 30;
        // Files on disk are ONLY a Studio convenience: a render request always
        // carries its arrays (an empty one means "none", never "read the disk").
        const p = props as {clips?: unknown; music?: unknown; captions?: unknown; brolls?: unknown};
        const fromDisk = async (file: string, fallback: unknown) => {
          const j = await fetch(staticFile(file)).then((r) => r.json()).catch(() => fallback);
          return Array.isArray(j) || (j && typeof j === 'object') ? j : fallback;
        };
        const tl = Array.isArray(p.clips) ? {clips: p.clips, music: p.music ?? null} : await fromDisk('timeline.json', {clips: [], music: null});
        const captions = Array.isArray(p.captions) ? p.captions : await fromDisk('captions.multi.json', []);
        const brolls = Array.isArray(p.brolls) ? p.brolls : await fromDisk('broll.json', []);
        return {
          fps,
          width: 1080,
          height: 1920,
          durationInFrames: totalDurationFrames(tl.clips, fps),
          props: {...props, clips: tl.clips, music: tl.music, captions, brolls},
        };
      }}
    />
  );
};
