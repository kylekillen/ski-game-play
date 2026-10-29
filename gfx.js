// The picture: sky, sun, shadows and the "lens" (everything that happens to
// the image after the 3D scene is drawn). main.js asks this file to draw a frame.
//
// Prior art this follows (2026-10-14 survey):
//  - two shadow cascades, the far one static and drawn once: the standard
//    cascaded-shadow-map idea (three.js examples/jsm/csm, Unreal/Unity CSM), cut to
//    two levels because the park never moves: only the skater's cascade redraws.
//  - contrast-adaptive sharpening: AMD FidelityFX CAS (MIT), the usual fix for a
//    soft upscaled image. SMAA on every level (three.js SMAAPass, Jimenez et al. 2012), run on the
//    tone-mapped picture: MSAA alone resolves in HDR, so bright-sky/dark-object edges (roof lines,
//    lamp posts, rails against the sky) stay stair-stepped; SMAA after tone mapping cleans those up.
//    Alpha-to-coverage on leaf and weed cards (park.js) smooths their cut-out edges under MSAA.
//    TAA was considered and passed over: the skater, board and camera all move fast and there is
//    no velocity buffer, so it would ghost; SMAA is one cheap 3-pass filter with no history.
//  - height fog / aerial perspective: Inigo Quilez's analytic exponential height fog
//    with sun in-scatter, as in UE "Exponential Height Fog".
//  - contact shading: three.js GTAOPass (ground-truth AO, Jimenez 2016).
//  - film grade: ACES-fitted filmic curve blended toward AgX (Troy Sobotka's filmic successor, Blender 4's default view
//    transform, three.js AgXToneMapping), whose highlight desaturation is what makes a render read as photographed
//    rather than drawn; then a warm-neutral split-tone and lifted blacks (LOOKS below).
import * as THREE from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

// What each graphicsQuality level switches on. px = max pixel ratio, msaa = edge
// smoothing samples, near/far = shadow map sizes (near follows the skater, far
// covers the whole park and is drawn once), reach = near shadow half-width (m),
// ao = contact shading (0 off, 0.5 half-res, 1 full), taps = blur samples, sharp = crispness.
const LEVELS = {
  low:    { px: 1,   msaa: 0, near: 1024, far: 2048, reach: 14, ao: 0,   aoN: 0,  taps: 0,  bloom: false, sharp: 0 },
  medium: { px: 1.5, msaa: 4, near: 2048, far: 4096, reach: 14, ao: 0.75, aoN: 12, taps: 10, bloom: true,  sharp: 0.45 },
  high:   { px: 2,   msaa: 4, near: 4096, far: 8192, reach: 14, ao: 1,   aoN: 16, taps: 18, bloom: true,  sharp: 0.3 },
};

// The sun lights the scene through two shadow maps: a sharp one round the skater and a
// wide one for everything else. This swaps three.js's per-light loop for one sun that
// reads whichever map covers the spot, blending at the seam.
(function cascadeChunk() {
  const C = THREE.ShaderChunk, src = C.lights_fragment_begin;
  const a = src.indexOf('#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )');
  const e = src.indexOf('#pragma unroll_loop_end', a), b = src.indexOf('#endif', e);
  if (a < 0 || e < 0 || b < 0) { console.error('gfx: three.js light shader changed; shadow cascades are off'); return; }
  const sh = (i) => `getShadow( directionalShadowMap[ ${i} ], directionalLightShadows[ ${i} ].shadowMapSize, directionalLightShadows[ ${i} ].shadowIntensity, directionalLightShadows[ ${i} ].shadowBias, directionalLightShadows[ ${i} ].shadowRadius, vDirectionalShadowCoord[ ${i} ] )`;
  C.lights_fragment_begin = src.slice(0, a) + `#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )
	DirectionalLight directionalLight = directionalLights[ 0 ];
	getDirectionalLightInfo( directionalLight, directLight );
	#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 1
	if ( directLight.visible && receiveShadow ) {
		vec2 e0 = min( vDirectionalShadowCoord[ 0 ].xy, 1.0 - vDirectionalShadowCoord[ 0 ].xy );
		float wN = smoothstep( 0.0, 0.12, min( e0.x, e0.y ) ), s = 1.0;
		if ( wN < 1.0 ) s = ${sh(1)};
		if ( wN > 0.0 ) s = mix( s, ${sh(0)}, wN );
		directLight.color *= s;
	}
	#elif defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
	directLight.color *= ( directLight.visible && receiveShadow ) ? ${sh(0)} : 1.0;
	#endif
	RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
` + src.slice(b);
})();

const LENS_FRAG = /* glsl */`
  #include <common>
  #include <packing>
  #include <tonemapping_pars_fragment>
  uniform sampler2D tColor, tDepth;
  uniform mat4 uProjInv, uCamWorld, uPrevVP;
  uniform vec2 uRes;
  uniform vec3 uCamPos, uSunDir, uSunCol, uFogCol;
  uniform float uNear, uFar, uFocus, uDofFar, uDofNear, uMb, uK, uVig, uSat, uContrast, uCA, uFogD, uFogH, uSkyHaze, uWarm, uSkySat, uSkyDeep, uAgx, uLift;
  uniform vec3 uShade, uHi;
  varying vec2 vUv;
  float zAt(vec2 uv) { return -perspectiveDepthToViewZ(texture2D(tDepth, uv).x, uNear, uFar); }
  // blur radius in pixels for something z metres from the lens
  float coc(float z) {
    float f = clamp((z - uFocus - 2.0) / (uFocus * 4.0 + 10.0), 0.0, 1.0);
    float n = clamp((min(uFocus * 0.5, 1.3) - z) / 1.0, 0.0, 1.0);
    return f * uDofFar + n * n * uDofNear;
  }
  float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
  void main() {
    // fisheye: squeeze the edges of the frame in, so the middle bulges
    float asp = uRes.x / uRes.y;
    vec2 c = vUv - 0.5; c.x *= asp;
    float r2 = dot(c, c), rm = 0.25 * (asp * asp + 1.0);
    vec2 uv = c * (1.0 + uK * r2) / (1.0 + uK * rm); uv.x /= asp; uv += 0.5;
    vec3 col = texture2D(tColor, uv).rgb;
    // cheap-lens colour fringing toward the corners (filmer cam)
    if (uCA > 0.0) { vec2 dc = (uv - 0.5) * r2 * uCA; col.r = texture2D(tColor, uv + dc).r; col.b = texture2D(tColor, uv - dc).b; }
    float d = texture2D(tDepth, uv).x, z = -perspectiveDepthToViewZ(d, uNear, uFar);
    vec4 wp = uCamWorld * (uProjInv * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0)); wp /= wp.w;
    #if TAPS > 0
      vec4 pc = uPrevVP * wp;
      vec2 vel = (uv - (pc.xy / pc.w * 0.5 + 0.5)) * uMb;
      if (pc.w <= 0.0) vel = vec2(0.0);
      vel *= smoothstep(0.7, 3.0, abs(z - uFocus));          // the skater stays sharp
      float vl = length(vel * uRes), vmax = 0.035 * uRes.y;
      if (vl > vmax) { vel *= vmax / vl; vl = vmax; }
      float cc = coc(z), bc = cc + vl;
      if (bc > 0.35) {
        float j = ign(gl_FragCoord.xy), wsum = 1.0;
        for (int i = 0; i < TAPS; i++) {
          float fi = (float(i) + j) / float(TAPS), a = float(i) * 2.39996 + j * 6.2832;
          vec2 suv = uv + vec2(cos(a), sin(a)) * sqrt(fi) * cc / uRes + vel * (fi - 0.5);
          float zi = zAt(suv);
          float bi = coc(zi) + vl * smoothstep(0.7, 3.0, abs(zi - uFocus));
          float w = zi > z - 0.25 ? 1.0 : clamp(bi / bc, 0.0, 1.0);   // sharp things in front don't smear
          col += texture2D(tColor, suv).rgb * w; wsum += w;
        }
        col /= wsum;
      }
    #endif
    // air: distance haze that thins with height, glowing warm toward the sun
    vec3 rd = wp.xyz - uCamPos; float t = length(rd); rd /= max(t, 1e-4);
    bool sky = d >= 0.999999;
    if (sky) {                                             // sky saturation and how much deeper it gets overhead (arcade: a polarised deep blue; sim: a pale, hazy real sky)
      t = 2500.0;
      float sl = dot(col, vec3(0.2126, 0.7152, 0.0722)), up = smoothstep(0.02, 0.6, rd.y);
      col = mix(vec3(sl), col, uSkySat + 0.35 * up * uSkyDeep) * mix(1.0, 0.86, up * uSkyDeep);
    }
    float q = max(rd.y, -0.2) * uFogH, L = abs(q * t) < 1e-3 ? t : (1.0 - exp(-t * q)) / q;
    float fog = 1.0 - exp(-uFogD * exp(-uCamPos.y * uFogH) * L);
    if (sky) fog *= uSkyHaze * (1.0 - smoothstep(0.0, 0.35, rd.y));
    float sg = max(dot(rd, uSunDir), 0.0);
    col = mix(col, uFogCol + uSunCol * (pow(sg, 10.0) * 0.06 + pow(sg, 2.0) * 0.012), fog);
    // tone curve: ACES (punchy, pushes bright colours toward saturated primaries) blended toward AgX
    // (a photographic film response: bright colours desaturate toward white the way real film and sensors do)
    col = mix(ACESFilmicToneMapping(col), AgXToneMapping(col), uAgx);
    // grade: saturation, a gentle S-curve, a split tone (uShade tints the shadows, uHi the highlights) and film lift
    float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(vec3(l), col, uSat);
    col = mix(col, col * col * (3.0 - 2.0 * col), uContrast);
    col *= mix(uShade, mix(vec3(1.0), uHi, uWarm), smoothstep(0.05, 0.8, l));
    col = col * (1.0 - 2.0 * uLift) + uLift;               // film lift: blacks sit a little up, like a print, not dead digital black
    col *= 1.0 - uVig * smoothstep(0.25, 1.05, length((vUv - 0.5) * vec2(1.0, 0.82)) * 1.45);
    gl_FragColor = vec4(sRGBTransferOETF(vec4(max(col, 0.0), 1.0)).rgb, 1.0);
  }`;
// last step: contrast-adaptive sharpening (after AMD FidelityFX CAS) and film grain
const OUT_FRAG = /* glsl */`
  uniform sampler2D tDiffuse; uniform vec2 uTexel; uniform float uSharp, uGrain, uTime;
  varying vec2 vUv;
  float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
  void main() {
    vec3 e = texture2D(tDiffuse, vUv).rgb;
    #if SHARP
      vec3 b = texture2D(tDiffuse, vUv - vec2(0.0, uTexel.y)).rgb, h = texture2D(tDiffuse, vUv + vec2(0.0, uTexel.y)).rgb;
      vec3 d = texture2D(tDiffuse, vUv - vec2(uTexel.x, 0.0)).rgb, f = texture2D(tDiffuse, vUv + vec2(uTexel.x, 0.0)).rgb;
      vec3 mn = min(e, min(min(b, d), min(f, h))), mx = max(e, max(max(b, d), max(f, h)));
      vec3 amp = sqrt(clamp(min(mn, 1.0 - mx) / max(mx, vec3(1e-4)), 0.0, 1.0));
      vec3 w = -amp / mix(8.0, 5.0, uSharp);
      e = clamp((e + (b + d + f + h) * w) / (1.0 + 4.0 * w), 0.0, 1.0);
    #endif
    e += (ign(gl_FragCoord.xy + fract(uTime) * 311.0) - 0.5) * uGrain;
    gl_FragColor = vec4(e, 1.0);
  }`;
const QUAD_VERT = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

// The overall look. 'sim' (the default, tweaks.js `look`, or ?look=arcade in the address to compare) is a grounded,
// photographic grade in the spirit of the realistic console skate sims: film-style tone curve, colour a touch under
// natural, gentle contrast, warm-neutral split, lifted blacks, a pale hazy sky and thicker air, softer shade.
// 'arcade' is the earlier bright, saturated, deep-blue-sky look.
//   sat: colour amount (1 = as lit)       contrast: S-curve strength        agx: 0 = ACES curve, 1 = AgX film curve
//   lift: black level                      shade/hi: shadow / highlight tint skySat, skyDeep: sky colour and overhead darkening
//   haze, skyHaze: air thickness / how far the haze climbs the sky       fill: shade light (sky + ground bounce)
//   env: sky-photo light   sunK: sunlight strength   soft: sun shadow edge softness   vig/grain: base vignette and grain
//   expo: exposure (the AgX curve sits a little darker in the mids, so the sim look opens up to match)
const LOOKS = {
  sim:    { sat: 0.95, contrast: 0.2, agx: 0.35, lift: 0.018, shade: [1.03, 1.005, 0.95], hi: [1.075, 1.02, 0.92], skySat: 1.0, skyDeep: 0.15,
            haze: 1.5, skyHaze: 0.45, fill: 1.3, env: 1.1, sunK: 0.95, soft: 2.2, vig: 0.2, grain: 0.011, expo: 1.08 },
  // snow: neutral-cool, so white snow stays white (a warm grade turns it cream) and shade goes the clean blue of real snow;
  // more contrast in the mids so the shape of the snow reads, highlights kept off the clip
  snow:   { sat: 1.0, contrast: 0.28, agx: 0.55, lift: 0.012, shade: [0.95, 0.99, 1.06], hi: [1.01, 1.005, 0.99], skySat: 1.05, skyDeep: 0.55,
            haze: 1.2, skyHaze: 0.35, fill: 0.85, env: 0.85, sunK: 1.0, soft: 1.6, vig: 0.16, grain: 0.008, expo: 1.0 },
  arcade: { sat: 1.16, contrast: 0.3, agx: 0, lift: 0.0125, shade: [0.955, 0.99, 1.04], hi: [1.05, 1.008, 0.94], skySat: 1.3, skyDeep: 1,
            haze: 1, skyHaze: 0.3, fill: 1, env: 1, sunK: 1, soft: 1.4, vig: 0.12, grain: 0.006, expo: 1 },
};

// How high the sun is at a given hour (24-hour clock): up at 7, highest (58°) at 1pm, down at 7pm.
const sunElev = (hour) => Math.max(3, 58 * Math.pow(Math.sin(Math.PI * Math.min(1, Math.max(0, (hour - 7) / 12))), 0.6)) * Math.PI / 180;   // a high, bright afternoon sun (5:30pm sits ~32°)
// sunlight colour and strength by elevation: deep amber near the horizon, near-white high up
function sunLight(elev) {
  const k = Math.min(1, elev / (40 * Math.PI / 180));
  const col = new THREE.Color().setRGB(1, 0.66 + 0.3 * Math.sqrt(k), 0.42 + 0.48 * k);
  return { col, power: 3.2 + 4.6 * Math.sqrt(k), sky: 0.7 + 0.35 * k, expo: 1.32 - 0.32 * k };   // expo: the camera opens up a little for low sun
}

export function createGfx(scene, camera, T) {
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
  // ?quality=high in the address bar overrides the tweak. A computer with no real graphics chip gets 'low'.
  const qs = new URLSearchParams(location.search), gl = renderer.getContext(), dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const soft = /swiftshader|llvmpipe|software/i.test(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '');
  const want = qs.get('quality') || (soft ? 'low' : T.graphicsQuality);
  const Q = { name: LEVELS[want] ? want : 'medium', ...(LEVELS[want] || LEVELS.medium) };
  const lookName = LOOKS[qs.get('look')] ? qs.get('look') : LOOKS[T.look] ? T.look : 'sim', LK = LOOKS[lookName];
  document.documentElement.dataset.quality = Q.name;   // park.js reads this to skip its costlier extras on 'low'
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.NoToneMapping;      // the lens pass tone-maps, so the scene stays in real light units
  document.body.prepend(renderer.domElement);
  const aniso = Math.min(Q.name === 'low' ? 4 : 16, renderer.capabilities.getMaxAnisotropy());

  // ── sky + sun. The sky photo lights the scene; the sun lamp does the direct light. ──
  // ?time=13 in the address overrides the timeOfDay tweak.
  const hour = +(qs.get('time') ?? T.timeOfDay ?? 17.5), elev = sunElev(hour), lightK = sunLight(elev);
  const golden = hour >= 15.5 || hour <= 9.5;      // late or early: warmer grade
  // the sky photo: clear deep-blue skies for the day, the old amber one only for a really low sun
  const skyFile = hour >= 18.4 || hour <= 7.6 ? 'golden_2k' : golden ? 'afternoon_2k' : 'clear_2k';
  const sunDir = new THREE.Vector3(), rot = (T.sunAngle ?? 0) * Math.PI / 180;
  let photoAz = Math.atan2(0.52, 0.45);
  scene.background = new THREE.Color(0x9db4c9);
  scene.backgroundRotation.y = scene.environmentRotation.y = rot;
  scene.environmentIntensity = lightK.sky * LK.env; scene.backgroundIntensity = 0.9 + 0.1 * lightK.sky;
  scene.fog = null;                                   // haze is done in the lens, where it can glow toward the sun
  const power = 1.15 * lightK.power * LK.sunK * (T.sunStrength ?? 1);
  const sun = new THREE.DirectionalLight(lightK.col, power);
  sun.castShadow = true; sun.shadow.mapSize.set(Q.near, Q.near);
  Object.assign(sun.shadow.camera, { left: -Q.reach, right: Q.reach, top: Q.reach, bottom: -Q.reach, near: 1, far: 300 });
  sun.shadow.bias = -0.0002; sun.shadow.normalBias = 0.018; sun.shadow.radius = LK.soft;
  // the wide map: the whole park and the streets round it, drawn once (the park never moves)
  const sunFar = new THREE.DirectionalLight(0xffffff, 0), FAR = 135;
  sunFar.castShadow = true; sunFar.shadow.mapSize.set(Q.far, Q.far); sunFar.shadow.autoUpdate = false;
  Object.assign(sunFar.shadow.camera, { left: -FAR, right: FAR, top: FAR, bottom: -FAR, near: 1, far: 700 });
  sunFar.shadow.bias = -0.0004; sunFar.shadow.normalBias = 0.06; sunFar.shadow.radius = 1.2;
  sunFar.shadow.camera.layers.set(1);                 // park.js puts the static world on layer 1, so no skater ghost
  scene.add(sun, sun.target, sunFar, sunFar.target);
  // bounce light: sunlit concrete throws warm light back up into the shade, the open sky fills from above.
  // A hemisphere light is the cheap stand-in for that global illumination (the "sky + ground bounce"
  // ambient most engines use under their GI), so the shaded side of a ramp or bowl stays readable.
  const fill = new THREE.HemisphereLight(T.fillSky ?? 0x9fb4cf, T.fillGround ?? 0xc2ad8f, 0.17 * power / LK.sunK * LK.fill * (T.shadeFill ?? 1));
  scene.add(fill);
  const farC = new THREE.Vector3();                   // the wide shadow map's centre: follows the skier down the mountain in jumps
  const place = () => {                                // sun direction (azimuth) from the photo, height from the clock
    const az = T.sunAz != null ? T.sunAz * Math.PI / 180 : photoAz - rot;
    if (T.sunAz != null) scene.backgroundRotation.y = scene.environmentRotation.y = photoAz - az;
    sunDir.set(Math.cos(elev) * Math.cos(az), Math.sin(elev), Math.cos(elev) * Math.sin(az)).normalize();
    sunFar.position.copy(farC).addScaledVector(sunDir, 320); sunFar.target.position.copy(farC);
    sunFar.updateMatrixWorld(); sunFar.target.updateMatrixWorld(); sunFar.shadow.needsUpdate = true;
  };
  place();
  const fogCol = new THREE.Color(0.62, 0.68, 0.76);
  new HDRLoader().load(`./assets/hdri/${skyFile}.hdr`, (tex) => {
    // find the sun (the brightest patch) and the colour of the sky at the horizon, then clip the
    // sun out of the photo: the sun lamp above does that job
    const d = tex.image.data, W = tex.image.width, H = tex.image.height, h2f = THREE.DataUtils.fromHalfFloat;
    const hot = THREE.DataUtils.toHalfFloat(150), cap = THREE.DataUtils.toHalfFloat(20), acc = new THREE.Vector3(), hz = [0, 0, 0, 0];
    for (let y = 0, i = 0; y < H; y++) {
      const th = (0.5 - (y + 0.5) / H) * Math.PI, band = th > 0.02 && th < 0.12;
      for (let x = 0; x < W; x++, i += 4) {
        if (d[i + 1] > hot && d[i + 1] < 0x7c00) {
          const phi = ((x + 0.5) / W - 0.5) * Math.PI * 2;
          acc.x += Math.cos(th) * Math.cos(phi); acc.y += Math.sin(th); acc.z += Math.cos(th) * Math.sin(phi);
        }
        if (band && (x & 7) === 0) { hz[0] += h2f(d[i]); hz[1] += h2f(d[i + 1]); hz[2] += h2f(d[i + 2]); hz[3]++; }
        for (let k = 0; k < 3; k++) if (d[i + k] > cap && d[i + k] < 0x7c00) d[i + k] = cap;
      }
    }
    if (acc.lengthSq() > 0) { acc.normalize(); photoAz = Math.atan2(acc.z, acc.x); api.photoSunElev = Math.asin(acc.y) * 180 / Math.PI; place(); }
    if (hz[3]) fogCol.setRGB(hz[0] / hz[3], hz[1] / hz[3], hz[2] / hz[3]).multiplyScalar(scene.backgroundIntensity);
    tex.mapping = THREE.EquirectangularReflectionMapping; tex.needsUpdate = true;
    scene.background = tex; scene.environment = tex;
    api.ready = true;
  }, undefined, (e) => console.error('sky failed to load', e));

  // keep the sharp shadow map centred on the action, moving in whole-texel steps so shadows don't shimmer
  const lm = new THREE.Matrix4(), li = new THREE.Matrix4(), lp = new THREE.Vector3(), O = new THREE.Vector3();
  function aimSun(focus) {
    lm.lookAt(sunDir, O, THREE.Object3D.DEFAULT_UP); li.copy(lm).invert();
    const texel = 2 * Q.reach / Q.near;
    lp.copy(focus).applyMatrix4(li);
    lp.x = Math.round(lp.x / texel) * texel; lp.y = Math.round(lp.y / texel) * texel; lp.z = Math.round(lp.z / texel) * texel;
    lp.applyMatrix4(lm);
    sun.target.position.copy(lp); sun.position.copy(lp).addScaledVector(sunDir, 150);
    sun.target.updateMatrixWorld(); sun.updateMatrixWorld();
  }

  // ── the lens: contact shading, glow, blur, fisheye, air, film look, crispness ──
  const depthTexture = new THREE.DepthTexture(4, 4); depthTexture.type = THREE.UnsignedIntType;
  const rtScene = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: Q.msaa, depthTexture });
  const rtMix = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: false });
  const rtOut = new THREE.WebGLRenderTarget(4, 4, { depthBuffer: false });
  const rtAA = new THREE.WebGLRenderTarget(4, 4, { depthBuffer: false });   // the smoothed picture, before sharpening and grain
  const gtao = Q.ao ? new GTAOPass(scene, camera, 4, 4) : null;
  if (gtao) {
    gtao.setGBuffer(depthTexture);     // reuse the depth we already drew instead of drawing the scene twice
    gtao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.4, thickness: 1.0, scale: 1.2, samples: Q.aoN, distanceFallOff: 1, screenSpaceRadius: false });
    gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, radiusExponent: 1, rings: 2, samples: Q.aoN });
    gtao.blendIntensity = 1;
    // contact shading is a near-field effect: fade it out far from the lens, where the depth buffer is too coarse for a
    // 0.6 m radius and it turns into dark dotted columns across distant hills (the mega park's landscape showed it)
    const gm = gtao.gtaoMaterial, aoTail = 'ao = pow(ao, scale);';
    if (gm.fragmentShader.includes(aoTail)) { gm.fragmentShader = gm.fragmentShader.replace(aoTail, aoTail + '\n\t\t\tao = mix(ao, 1., smoothstep(55., 130., -viewPos.z));'); gm.needsUpdate = true; }
    else console.error('gfx: GTAO shader changed; far contact-shading fade is off');
  }
  const bloom = Q.bloom ? new UnrealBloomPass(new THREE.Vector2(4, 4), 0.12 * (T.glow ?? 1), 0.5, 3.5) : null;
  const lens = new THREE.ShaderMaterial({
    defines: { TAPS: Q.taps }, vertexShader: QUAD_VERT, fragmentShader: LENS_FRAG, depthTest: false, depthWrite: false,
    uniforms: {
      tColor: { value: null }, tDepth: { value: depthTexture }, uRes: { value: new THREE.Vector2() },
      uProjInv: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() }, uPrevVP: { value: new THREE.Matrix4() },
      uNear: { value: 0.1 }, uFar: { value: 1000 }, uFocus: { value: 3 }, uDofFar: { value: 0 }, uDofNear: { value: 0 }, uMb: { value: 0 },
      uK: { value: 0 }, uVig: { value: 0.3 }, uSat: { value: LK.sat }, uContrast: { value: LK.contrast }, uSkySat: { value: LK.skySat }, uSkyDeep: { value: LK.skyDeep }, uCA: { value: 0 }, uWarm: { value: golden ? 1 : 0.5 },
      uAgx: { value: LK.agx }, uLift: { value: LK.lift }, uShade: { value: new THREE.Vector3(...LK.shade) }, uHi: { value: new THREE.Vector3(...LK.hi) },
      uCamPos: { value: new THREE.Vector3() }, uSunDir: { value: sunDir }, uSunCol: { value: new THREE.Color().copy(lightK.col).multiplyScalar(power) },
      uFogCol: { value: fogCol }, uFogD: { value: 0.0009 * LK.haze * (T.haze ?? 1) }, uFogH: { value: 0.035 }, uSkyHaze: { value: LK.skyHaze },
      toneMappingExposure: { value: 1 },
    },
  });
  const out = new THREE.ShaderMaterial({
    defines: { SHARP: Q.sharp > 0 ? 1 : 0 }, vertexShader: QUAD_VERT, fragmentShader: OUT_FRAG, depthTest: false, depthWrite: false,
    uniforms: { tDiffuse: { value: rtAA.texture }, uTexel: { value: new THREE.Vector2() }, uSharp: { value: Q.sharp }, uGrain: { value: 0.012 }, uTime: { value: 0 } },
  });
  // ?aa=0 in the address turns the edge smoothing off (to compare)
  const smaa = qs.get('aa') === '0' ? null : new SMAAPass();
  if (smaa) smaa.renderToScreen = !(Q.sharp > 0);
  if (!smaa) out.uniforms.tDiffuse.value = rtOut.texture;
  const quad = new FullScreenQuad(lens);
  const size = new THREE.Vector2();
  let time = 0, first = true, farFrames = 0;

  let resScale = 1;                                   // dynamic resolution: main.js lowers it when frames run long
  function resize() {
    const px = Math.max(0.6, Math.min(devicePixelRatio, Q.px) * resScale);
    renderer.setPixelRatio(px); renderer.setSize(innerWidth, innerHeight);
    renderer.getDrawingBufferSize(size);
    const w = size.x, h = size.y;
    rtScene.setSize(w, h); rtMix.setSize(w, h); rtOut.setSize(w, h); rtAA.setSize(w, h);
    if (gtao) { gtao.setSize(Math.round(w * Q.ao), Math.round(h * Q.ao)); gtao.normalRenderTarget.setSize(4, 4); }
    if (bloom) bloom.setSize(w, h);
    if (smaa) smaa.setSize(w, h);
    lens.uniforms.uRes.value.set(w, h); out.uniforms.uTexel.value.set(1 / w, 1 / h);
    camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  }
  addEventListener('resize', resize); resize();

  // Draw one frame. focus = the point to keep sharp and shadowed (the skater).
  // Compile every shader and upload every texture before the first frame, so turning the camera
  // toward the city never stalls a frame (a stall there would also cost the physics a step).
  let warm = 0;
  function warmUp() {
    renderer.compile(scene, camera);
    scene.traverse((o) => { for (const m of [].concat(o.material || [])) for (const k of ['map', 'normalMap', 'roughnessMap', 'emissiveMap', 'alphaMap'])
      if (m[k] && m[k].isTexture && (m[k].image || m[k].source?.data)) renderer.initTexture(m[k]); });
  }
  function render(dt, focus) {
    time += dt;
    if (!soft && warm < 2 && (warm === 0 || api.ready)) { warmUp(); warm = api.ready ? 2 : 1; }   // (software GL: compiling all at once only slows the load)
    aimSun(focus);
    // the wide shadow map: redraw for the first few frames (textures and the sky settle), then never
    if (farFrames < 3) { sunFar.shadow.needsUpdate = true; if (api.ready) farFrames++; }
    if (Math.hypot(focus.x - farC.x, focus.z - farC.z) > 70 || Math.abs(focus.y - farC.y) > 60) { farC.set(Math.round(focus.x / 10) * 10, Math.round(focus.y / 10) * 10, Math.round(focus.z / 10) * 10 + 40); place(); }
    camera.updateMatrixWorld();
    renderer.setRenderTarget(rtScene); renderer.render(scene, camera);
    let src = rtScene;
    if (gtao && api.aoOn) { gtao.render(renderer, rtMix, rtScene, dt, false); src = rtMix; }
    if (bloom && api.bloomOn && src === rtMix) bloom.render(renderer, null, rtMix, dt, false);
    const u = lens.uniforms, s = size.y / 1080, v = api.view;
    u.tColor.value = src.texture;
    u.uProjInv.value.copy(camera.projectionMatrixInverse); u.uCamWorld.value.copy(camera.matrixWorld);
    if (first) { u.uPrevVP.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse); first = false; }
    u.uNear.value = camera.near; u.uFar.value = camera.far; u.uCamPos.value.copy(camera.position);
    const fd = Math.max(0.6, focus.distanceTo(camera.position));
    u.uFocus.value += (fd - u.uFocus.value) * Math.min(1, 8 * dt);
    const dof = (T.depthOfField ?? 1) * (v?.dof ?? 1);
    u.uDofFar.value = 2.4 * s * dof; u.uDofNear.value = 7 * s * dof;
    u.uMb.value = (T.motionBlur ?? 1) * 0.34 * (1 / 60) / Math.max(dt, 1 / 240);
    const fish = (T.fisheye ?? 0.5) * (v?.fisheye ?? 1), f1 = Math.min(1, fish * 1.4);
    u.uK.value = 0.3 * fish;
    u.uCA.value = 0.005 * f1;                             // colour fringing comes with the cheap wide lens
    u.uVig.value = LK.vig + 0.2 * f1;
    u.toneMappingExposure.value = (T.exposure ?? 1) * lightK.expo * LK.expo;
    quad.material = lens; renderer.setRenderTarget(rtOut); quad.render(renderer);
    if (smaa && smaa.renderToScreen) smaa.render(renderer, null, rtOut);
    else { if (smaa) smaa.render(renderer, rtAA, rtOut); out.uniforms.uTime.value = time; out.uniforms.uGrain.value = LK.grain + 0.008 * f1; quad.material = out; renderer.setRenderTarget(null); quad.render(renderer); }
    u.uPrevVP.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  }

  const setScale = (k) => { k = Math.max(0.5, Math.min(1, k)); if (Math.abs(k - resScale) < 0.02) return; resScale = k; resize(); };
  const api = { renderer, render, resize, setScale, get scale() { return resScale; }, sun, sunFar, sunDir, fill, quality: Q, look: lookName, aniso, lens, out, bloom, gtao, ready: false, aoOn: true, bloomOn: true, hour };
  return api;
}
