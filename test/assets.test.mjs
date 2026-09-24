import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fluentPngUrl, isPrivateAddress, wrapPrompt} from '../mcp/assets.mjs';

test('fluentPngUrl maps an iconify emoji name to the Fluent 3D PNG path', () => {
  assert.equal(fluentPngUrl('grinning-face'), 'https://cdn.jsdelivr.net/gh/microsoft/fluentui-emoji@main/assets/Grinning%20face/3D/grinning_face_3d.png');
});

test('private and loopback addresses are refused for downloads', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.9', '172.16.5.5', '169.254.169.254', '::1', 'fd00::1']) assert.ok(isPrivateAddress(ip), ip);
  for (const ip of ['8.8.8.8', '104.16.0.1', '2606:4700::1']) assert.ok(!isPrivateAddress(ip), ip);
});

test('wrapPrompt adds the sticker style and transparency instructions', () => {
  assert.match(wrapPrompt('sticker', 'a red lightning bolt'), /^a red lightning bolt\. Die-cut sticker.*transparent background/);
  assert.match(wrapPrompt('texture', 'kraft paper'), /^Seamless tileable kraft paper texture/);
});
