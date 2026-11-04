// Every tile is one quad. Colors and letters are resolved per fragment, so the
// cost of a tile does not depend on how many cells it holds.

export const VERTEX = `
precision highp float;
attribute vec2 aVertexPosition;
uniform mat3 projectionMatrix;
uniform mat3 translationMatrix;
uniform vec2 uUvScale;
varying vec2 vUv;
void main() {
  vUv = aVertexPosition * uUvScale;
  gl_Position = vec4((projectionMatrix * translationMatrix * vec3(aVertexPosition, 1.0)).xy, 0.0, 1.0);
}`;

// Raw level: one byte per cell, low 3 bits = symbol, bit 3 = differs from consensus.
export const RAW_FRAGMENT = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uData;
uniform sampler2D uPalette;
uniform sampler2D uAtlas;
uniform vec2 uDims;
uniform vec2 uCellPx;
uniform float uLetterAlpha;
void main() {
  float b = floor(texture2D(uData, vUv).r * 255.0 + 0.5);
  float sym = mod(b, 8.0);
  float mismatch = floor(b / 8.0);
  vec3 color = texture2D(uPalette, vec2((sym + 0.5) / 8.0, (mismatch + 0.5) / 2.0)).rgb;
  if (uLetterAlpha > 0.0) {
    vec2 px = fract(vUv * uDims) * uCellPx;
    float side = min(uCellPx.x, uCellPx.y);
    vec2 g = (px - 0.5 * uCellPx) / side + 0.5;
    if (g.x >= 0.0 && g.x <= 1.0 && g.y >= 0.0 && g.y <= 1.0) {
      float a = texture2D(uAtlas, vec2((sym + g.x) / 8.0, g.y)).a;
      color = mix(color, vec3(0.08), a * uLetterAlpha);
    }
  }
  gl_FragColor = vec4(color, 1.0);
}`;

// Overview levels: two RGBA8 textures of baked raw-level colors, the bin's mean color
// and the same bin at its peak mismatch rate. uEmphasis slides between them so rare
// mismatches survive aggregation, and reaches 0 where the raw level takes over.
//
// Bins aggregate columns only; rows are never merged. So neighbours are blended along
// x by hand rather than with a LINEAR sampler, which would also smear sequences into
// each other. uSmooth of 1 is linear, 0 is hard-edged.
export const OVERVIEW_FRAGMENT = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uMean;
uniform sampler2D uPeak;
uniform vec2 uDims;
uniform float uEmphasis;
uniform float uSmooth;
void main() {
  float x = vUv.x * uDims.x - 0.5;
  float left = floor(x);
  float du = 1.0 / uDims.x;
  vec2 uvA = vec2((left + 0.5) * du, vUv.y);
  vec2 uvB = vec2((left + 1.5) * du, vUv.y);
  float f = x - left;
  float t = clamp(0.5 + (f - 0.5) / max(uSmooth, 0.001), 0.0, 1.0);
  vec3 mean = mix(texture2D(uMean, uvA).rgb, texture2D(uMean, uvB).rgb, t);
  vec3 peak = mix(texture2D(uPeak, uvA).rgb, texture2D(uPeak, uvB).rgb, t);
  gl_FragColor = vec4(mix(mean, peak, uEmphasis), 1.0);
}`;
