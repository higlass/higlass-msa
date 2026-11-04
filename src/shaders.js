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

// Overview levels: RGBA8 per cell = non-gap fraction, mean mismatch, peak mismatch, dominant symbol.
export const OVERVIEW_FRAGMENT = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uData;
void main() {
  vec4 t = texture2D(uData, vUv);
  vec3 color = mix(vec3(0.97), vec3(0.80, 0.84, 0.90), t.r);
  float heat = clamp(max(sqrt(t.g), t.b * 0.9), 0.0, 1.0);
  color = mix(color, vec3(0.80, 0.10, 0.12), heat);
  gl_FragColor = vec4(color, 1.0);
}`;
