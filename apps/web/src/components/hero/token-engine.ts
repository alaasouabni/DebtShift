/*
 * The 3D hero, drawn with three.js.
 *
 * What it shows, for the stage it is given (the same stages as the flow card
 * under it, and the same rules: it never runs ahead of the stage):
 *
 *   - two rate dials, one per market. The lit arc of a dial is the borrow
 *     rate, so the dearer market visibly has the longer arc;
 *   - an Ethereum crystal, the collateral, sitting in the source dial;
 *   - a USDC coin orbiting it, the debt. When the old loan is closed the coin
 *     is absorbed and the source arc drains; when the new loan opens a coin
 *     appears on the destination and its arc fills;
 *   - between the dials, the transport beam the collateral crosses.
 *
 * No React here: the component owns the canvas and the labels and calls in.
 * Everything stops drawing when the scene is off screen or the tab is hidden.
 */

import { gsap } from 'gsap';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

import type { FlowStage } from '../flow/flow-stage';
import { sceneStateFor, type TokenSpot } from './scene-state';

export type SceneTheme = 'dark' | 'light';

export interface TokenSceneLabels {
  readonly source?: HTMLElement | null;
  readonly destination?: HTMLElement | null;
  readonly beam?: HTMLElement | null;
}

export interface TokenSceneOptions {
  readonly theme: SceneTheme;
  readonly sourceRateBps: number;
  readonly destinationRateBps: number;
  readonly labels: TokenSceneLabels;
}

export interface TokenSceneHandle {
  setStage(stage: FlowStage, instant?: boolean): void;
  setTheme(theme: SceneTheme): void;
  setPlaying(playing: boolean): void;
  resize(width: number, height: number): void;
  pointer(x: number, y: number): void;
  setVisible(visible: boolean): void;
  destroy(): void;
}

const PALETTE = {
  dark: {
    track: 0x1c3a5e,
    source: 0xf2b45c,
    destination: 0x3fb6c5,
    beam: 0x6bcad6,
    ticks: 0x5a7799,
    particles: 0x8fd6e0,
    glowBlend: THREE.AdditiveBlending,
    glowOpacity: 0.38,
  },
  light: {
    track: 0xc9d6e2,
    source: 0xc27a12,
    destination: 0x0b8796,
    beam: 0x0b8796,
    ticks: 0x9fb1c4,
    particles: 0x3fb6c5,
    glowBlend: THREE.NormalBlending,
    glowOpacity: 0.22,
  },
} as const;

/** One percentage point of borrow rate is this many degrees of arc. */
const DEGREES_PER_POINT = 36;
const DIAL_RADIUS = 1.32;
const SOURCE_X = -2.95;
const DESTINATION_X = 2.95;
const DIAL_Y = 0.15;
const CAMERA_Z = 14.2;

/** Where along the crossing the crystal sits, for each spot a stage puts it. */
const PATH_POSITION: Record<TokenSpot, number> = {
  'on-source': 0,
  lifted: 0.14,
  'mid-air': 0.5,
  'above-destination': 0.86,
  'on-destination': 1,
};

/** Arc angle for a rate, clamped to a readable range. */
export function arcRadiansFor(rateBps: number): number {
  if (!Number.isFinite(rateBps) || rateBps <= 0) return 0.2;
  const degrees = Math.min(330, Math.max(12, (rateBps / 100) * DEGREES_PER_POINT));
  return THREE.MathUtils.degToRad(degrees);
}

/* ------------------------------------------------------------- geometry */

/**
 * The Ethereum mark as a solid: an elongated upper diamond and, below a small
 * gap, the chevron. Flat-shaded so every facet catches the light on its own.
 */
function ethereumGeometry(): THREE.BufferGeometry {
  const r = 0.78;
  const rim = [
    new THREE.Vector3(r, 0, 0),
    new THREE.Vector3(0, 0, r),
    new THREE.Vector3(-r, 0, 0),
    new THREE.Vector3(0, 0, -r),
  ];
  const top = new THREE.Vector3(0, 1.32, 0);
  const upperBottom = new THREE.Vector3(0, -0.3, 0);
  const lowerRim = rim.map((v) => v.clone().setY(-0.16));
  const lowerDip = new THREE.Vector3(0, -0.44, 0);
  const bottom = new THREE.Vector3(0, -1.3, 0);

  const positions: number[] = [];
  const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => {
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  };
  for (let i = 0; i < 4; i += 1) {
    const a = rim[i]!;
    const b = rim[(i + 1) % 4]!;
    tri(top, b, a);
    tri(upperBottom, a, b);
    const la = lowerRim[i]!;
    const lb = lowerRim[(i + 1) % 4]!;
    tri(lowerDip, lb, la);
    tri(bottom, la, lb);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * The NEAR coin's face: a dark disc, a green rim, and a white N drawn the way
 * the NEAR mark draws it: two uprights joined by a diagonal that ends in a
 * notch at each foot.
 */
function nearFaceTexture(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const c = size / 2;
  const g = ctx.createRadialGradient(c * 0.8, c * 0.7, size * 0.05, c, c, c);
  g.addColorStop(0, '#2a2f36');
  g.addColorStop(1, '#0b0d10');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(c, c, c, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#00ec97';
  ctx.lineWidth = 14;
  ctx.beginPath();
  ctx.arc(c, c, c - 22, 0, Math.PI * 2);
  ctx.stroke();

  // The N, in a 100-unit box centred on the coin.
  const u = size / 190;
  const ox = c - 50 * u;
  const oy = c - 50 * u;
  const pt = (x: number, y: number): [number, number] => [ox + x * u, oy + y * u];
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  // Left upright, with the notch at its foot where the diagonal meets it.
  ctx.moveTo(...pt(4, 100));
  ctx.lineTo(...pt(4, 6));
  ctx.quadraticCurveTo(...pt(4, 0), ...pt(11, 0));
  ctx.lineTo(...pt(22, 0));
  // Diagonal down to the right upright's foot.
  ctx.lineTo(...pt(80, 74));
  ctx.lineTo(...pt(80, 0));
  ctx.lineTo(...pt(96, 0));
  ctx.lineTo(...pt(96, 94));
  ctx.quadraticCurveTo(...pt(96, 100), ...pt(89, 100));
  ctx.lineTo(...pt(78, 100));
  // Diagonal back up to the left upright.
  ctx.lineTo(...pt(20, 26));
  ctx.lineTo(...pt(20, 100));
  ctx.closePath();
  ctx.fill();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

function coinFaceTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(
    size * 0.4,
    size * 0.35,
    size * 0.05,
    size / 2,
    size / 2,
    size / 2,
  );
  g.addColorStop(0, '#4b93e6');
  g.addColorStop(1, '#1f5fae');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 12;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 26, Math.PI * 0.62, Math.PI * 1.38);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 26, Math.PI * 1.62, Math.PI * 2.38);
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 112px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('$', size / 2, size / 2 + 6);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function glowTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.3, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  return texture;
}

/* ---------------------------------------------------------------- dials */

interface Dial {
  readonly group: THREE.Group;
  readonly track: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>;
  readonly arc: THREE.Mesh<THREE.TorusGeometry, THREE.MeshStandardMaterial>;
  readonly ticks: THREE.InstancedMesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>;
  readonly glow: THREE.Sprite;
  /** The full arc for this market's rate. */
  readonly fullArc: number;
  /** How much of it is drawn, 0..1. */
  fill: number;
  shownFill: number;
}

function makeDial(x: number, rateBps: number, colour: number, glowMap: THREE.Texture): Dial {
  const group = new THREE.Group();
  group.position.set(x, DIAL_Y, 0);
  const track = new THREE.Mesh(
    new THREE.TorusGeometry(DIAL_RADIUS, 0.035, 12, 128),
    new THREE.MeshBasicMaterial({ color: 0x1c3a5e, transparent: true, opacity: 0.9 }),
  );
  group.add(track);
  const fullArc = arcRadiansFor(rateBps);
  const arc = new THREE.Mesh(
    new THREE.TorusGeometry(DIAL_RADIUS, 0.075, 16, 160, fullArc),
    new THREE.MeshStandardMaterial({
      color: colour,
      emissive: colour,
      emissiveIntensity: 0.9,
      metalness: 0.3,
      roughness: 0.35,
    }),
  );
  // The arc starts at the top and runs clockwise, like a gauge.
  arc.rotation.z = Math.PI / 2;
  arc.scale.x = -1;
  group.add(arc);

  const tickCount = 40;
  const ticks = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.018, 0.12, 0.018),
    new THREE.MeshBasicMaterial({ color: 0x5a7799, transparent: true, opacity: 0.8 }),
    tickCount,
  );
  const m = new THREE.Matrix4();
  for (let i = 0; i < tickCount; i += 1) {
    const angle = (i / tickCount) * Math.PI * 2;
    const r = DIAL_RADIUS + 0.24;
    m.makeRotationZ(-angle);
    m.setPosition(Math.sin(angle) * r, Math.cos(angle) * r, 0);
    ticks.setMatrixAt(i, m);
  }
  group.add(ticks);

  const glow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowMap,
      color: colour,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0.5,
    }),
  );
  glow.scale.set(5.4, 5.4, 1);
  glow.position.z = -0.4;
  group.add(glow);

  return { group, track, arc, ticks, glow, fullArc, fill: 1, shownFill: 1 };
}

function setArcFill(dial: Dial, fill: number) {
  const f = THREE.MathUtils.clamp(fill, 0, 1);
  if (Math.abs(f - dial.shownFill) < 0.002) return;
  dial.shownFill = f;
  const geometry = new THREE.TorusGeometry(
    DIAL_RADIUS,
    0.075,
    16,
    160,
    Math.max(0.0001, dial.fullArc * f),
  );
  dial.arc.geometry.dispose();
  dial.arc.geometry = geometry;
  dial.arc.visible = f > 0.002;
}

/* ================================================================ scene */

export function createTokenScene(
  canvas: HTMLCanvasElement,
  options: TokenSceneOptions,
): TokenSceneHandle {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = environment;

  const camera = new THREE.PerspectiveCamera(30, 1.25, 0.1, 100);
  camera.position.set(0, 1.4, CAMERA_Z);
  camera.lookAt(0, 0.6, 0);

  scene.add(new THREE.AmbientLight(0xffffff, 0.4));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(3, 6, 8);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x7fb8ff, 1.6);
  rim.position.set(-6, 2, -4);
  scene.add(rim);

  const rig = new THREE.Group();
  scene.add(rig);

  const glowMap = glowTexture();
  const sourceDial = makeDial(SOURCE_X, options.sourceRateBps, PALETTE.dark.source, glowMap);
  const destinationDial = makeDial(
    DESTINATION_X,
    options.destinationRateBps,
    PALETTE.dark.destination,
    glowMap,
  );
  rig.add(sourceDial.group, destinationDial.group);

  /* The crossing: from the source dial, up through the beam, down into the destination. */
  const crossing = new THREE.CatmullRomCurve3([
    new THREE.Vector3(SOURCE_X, DIAL_Y, 0.2),
    new THREE.Vector3(SOURCE_X + 0.4, DIAL_Y + 1.5, 0.3),
    new THREE.Vector3(0, DIAL_Y + 2.35, 0.35),
    new THREE.Vector3(DESTINATION_X - 0.4, DIAL_Y + 1.5, 0.3),
    new THREE.Vector3(DESTINATION_X, DIAL_Y, 0.2),
  ]);
  const beamUniforms = {
    uTime: { value: 0 },
    uColor: { value: new THREE.Color(PALETTE.dark.beam) },
    uStrength: { value: 0.35 },
    uHead: { value: 0 },
  };
  const beamMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: beamUniforms,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform vec3 uColor; uniform float uStrength; uniform float uHead;
      varying vec2 vUv;
      void main() {
        float dash = smoothstep(0.35, 0.65, fract(vUv.x * 26.0 - uTime * 0.9));
        float head = exp(-pow((vUv.x - uHead) * 9.0, 2.0));
        float edge = smoothstep(0.0, 0.08, vUv.x) * smoothstep(1.0, 0.92, vUv.x);
        float a = (0.18 + 0.5 * dash) * uStrength * edge + head * 0.9 * uStrength;
        gl_FragColor = vec4(uColor, a);
      }`,
  });
  const beam = new THREE.Mesh(new THREE.TubeGeometry(crossing, 180, 0.03, 8, false), beamMaterial);
  rig.add(beam);

  /* The Ethereum crystal. */
  const ethMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x7383e8,
    metalness: 0.35,
    roughness: 0.12,
    clearcoat: 1,
    clearcoatRoughness: 0.08,
    iridescence: 0.9,
    iridescenceIOR: 1.35,
    flatShading: true,
    envMapIntensity: 1.4,
  });
  const eth = new THREE.Mesh(ethereumGeometry(), ethMaterial);
  eth.scale.setScalar(0.72);
  const ethGroup = new THREE.Group();
  ethGroup.add(eth);
  const ethGlow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowMap,
      color: 0x8fa0ff,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0.45,
    }),
  );
  ethGlow.scale.set(2.6, 2.6, 1);
  ethGlow.position.z = -0.3;
  ethGroup.add(ethGlow);
  rig.add(ethGroup);

  /* NEAR Intents: the coin the collateral crosses through, at the top of the arc. */
  const nearFaceMap = nearFaceTexture();
  // A cylinder's cap maps its texture a quarter turn off; turn it back so the N stands upright.
  nearFaceMap.center.set(0.5, 0.5);
  nearFaceMap.rotation = Math.PI / 2;
  const nearFace = new THREE.MeshStandardMaterial({
    map: nearFaceMap,
    metalness: 0.45,
    roughness: 0.28,
  });
  const nearEdge = new THREE.MeshStandardMaterial({
    color: 0x1a1f25,
    metalness: 0.9,
    roughness: 0.2,
    emissive: 0x00ec97,
    emissiveIntensity: 0.18,
  });
  const nearMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.11, 72), [
    nearEdge,
    nearFace,
    nearFace,
  ]);
  nearMesh.rotation.x = Math.PI / 2;
  const near = new THREE.Group();
  near.add(nearMesh);
  const nearGlow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowMap,
      color: 0x00ec97,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0.3,
    }),
  );
  nearGlow.scale.set(3.4, 3.4, 1);
  nearGlow.position.z = -0.3;
  near.add(nearGlow);
  const NEAR_POINT = new THREE.Vector3(0, DIAL_Y + 2.35, -0.55);
  near.position.copy(NEAR_POINT);
  rig.add(near);
  let nearSpin = 0;

  /* The USDC coins: the old debt and the new. */
  const faceMap = coinFaceTexture();
  const coinFace = new THREE.MeshStandardMaterial({
    map: faceMap,
    metalness: 0.35,
    roughness: 0.3,
  });
  const coinEdge = new THREE.MeshStandardMaterial({
    color: 0x9cc8ff,
    metalness: 0.85,
    roughness: 0.22,
  });
  const makeCoin = () => {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.075, 56), [
      coinEdge,
      coinFace,
      coinFace,
    ]);
    mesh.rotation.x = Math.PI / 2;
    const holder = new THREE.Group();
    holder.add(mesh);
    return holder;
  };
  const oldDebt = makeCoin();
  const newDebt = makeCoin();
  sourceDial.group.add(oldDebt);
  destinationDial.group.add(newDebt);

  /* Dust in the air. */
  const dustCount = 160;
  const dustPositions = new Float32Array(dustCount * 3);
  for (let i = 0; i < dustCount; i += 1) {
    dustPositions[i * 3] = (Math.random() - 0.5) * 12;
    dustPositions[i * 3 + 1] = (Math.random() - 0.4) * 6;
    dustPositions[i * 3 + 2] = (Math.random() - 0.5) * 4 - 1;
  }
  const dustGeometry = new THREE.BufferGeometry();
  dustGeometry.setAttribute('position', new THREE.BufferAttribute(dustPositions, 3));
  const dust = new THREE.Points(
    dustGeometry,
    new THREE.PointsMaterial({
      color: PALETTE.dark.particles,
      size: 0.035,
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
    }),
  );
  rig.add(dust);

  /* Trail behind the crystal while it travels. */
  const trailCount = 60;
  const trailPositions = new Float32Array(trailCount * 3);
  const trailGeometry = new THREE.BufferGeometry();
  trailGeometry.setAttribute('position', new THREE.BufferAttribute(trailPositions, 3));
  const trail = new THREE.Points(
    trailGeometry,
    new THREE.PointsMaterial({
      color: 0xa9b6ff,
      size: 0.06,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  rig.add(trail);

  /* ------------------------------------------------------------- state */

  const state = {
    u: 0, // position along the crossing
    oldDebt: 1, // scale of the old debt coin
    newDebt: 0, // scale of the new debt coin
    destLit: 0,
    beam: 0.35,
    ethOpacity: 1,
  };
  let stage: FlowStage = 'ready';
  let playing = true;
  let visible = true;
  let running = false;
  let destroyed = false;
  let theme: SceneTheme = options.theme;
  const clock = new THREE.Clock();
  let elapsed = 0;
  const pointerTarget = { x: 0, y: 0 };
  const pointerNow = { x: 0, y: 0 };
  let width = 1;
  let height = 1;

  function applyTheme(next: SceneTheme) {
    theme = next;
    const p = PALETTE[next];
    for (const dial of [sourceDial, destinationDial]) {
      dial.track.material.color.setHex(p.track);
      dial.ticks.material.color.setHex(p.ticks);
      dial.glow.material.blending = p.glowBlend;
      dial.glow.material.needsUpdate = true;
    }
    sourceDial.arc.material.color.setHex(p.source);
    sourceDial.arc.material.emissive.setHex(p.source);
    sourceDial.glow.material.color.setHex(p.source);
    destinationDial.arc.material.color.setHex(p.destination);
    destinationDial.arc.material.emissive.setHex(p.destination);
    destinationDial.glow.material.color.setHex(p.destination);
    const emissive = next === 'dark' ? 0.9 : 0.35;
    // Amber washes out to white under the tone mapping long before teal does.
    sourceDial.arc.material.emissiveIntensity = next === 'dark' ? 0.5 : 0.3;
    destinationDial.arc.material.emissiveIntensity = emissive;
    beamUniforms.uColor.value.setHex(p.beam);
    (dust.material as THREE.PointsMaterial).color.setHex(p.particles);
    (dust.material as THREE.PointsMaterial).opacity = next === 'dark' ? 0.6 : 0.28;
    // On a white page the crystal needs a deeper body colour to keep its facets.
    ethMaterial.color.setHex(next === 'dark' ? 0x7383e8 : 0x4f5fd6);
    ethMaterial.envMapIntensity = next === 'dark' ? 1.4 : 1.1;
    nearGlow.material.blending = p.glowBlend;
    nearGlow.material.needsUpdate = true;
    ethGlow.material.blending = p.glowBlend;
    ethGlow.material.needsUpdate = true;
    renderer.toneMappingExposure = next === 'dark' ? 1.1 : 0.95;
    requestFrame();
  }

  function targetsFor(next: FlowStage) {
    const s = sceneStateFor(next);
    return {
      u: PATH_POSITION[s.token],
      oldDebt: s.sourceLoanOpen ? 1 : 0,
      newDebt: s.destinationLoanOpen ? 1 : 0,
      destLit: s.destinationLit ? 1 : 0,
      beam:
        s.token === 'mid-air' || s.token === 'lifted' || s.token === 'above-destination' ? 1 : 0.35,
    };
  }

  function setStage(next: FlowStage, instant = false) {
    const previous = stage;
    stage = next;
    const target = targetsFor(next);
    gsap.killTweensOf(state);
    if (instant || !playing) {
      Object.assign(state, target, { ethOpacity: 1 });
      requestFrame();
      return;
    }
    // Back to the start of the loop: fade out where it is, reappear at the source.
    if (target.u < state.u - 0.05 && next === 'ready' && previous === 'settled') {
      gsap
        .timeline()
        .to(state, { ethOpacity: 0, newDebt: 0, destLit: 0, duration: 0.45, ease: 'power2.in' })
        .set(state, { u: 0 })
        .to(state, { ethOpacity: 1, oldDebt: 1, beam: 0.35, duration: 0.6, ease: 'power2.out' });
    } else {
      gsap.to(state, {
        ...target,
        ethOpacity: 1,
        duration: 1.35,
        ease: 'power3.inOut',
        onUpdate: requestFrame,
      });
    }
    requestFrame();
  }

  /* ------------------------------------------------------------ labels */

  const projected = new THREE.Vector3();
  function placeLabel(element: HTMLElement | null | undefined, point: THREE.Vector3) {
    if (!element) return;
    projected.copy(point);
    rig.localToWorld(projected);
    projected.project(camera);
    const x = (projected.x * 0.5 + 0.5) * width;
    const y = (-projected.y * 0.5 + 0.5) * height;
    element.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, 0)`;
  }
  const labelPoints = {
    source: new THREE.Vector3(SOURCE_X, DIAL_Y - DIAL_RADIUS - 0.5, 0),
    destination: new THREE.Vector3(DESTINATION_X, DIAL_Y - DIAL_RADIUS - 0.5, 0),
    beam: new THREE.Vector3(0, DIAL_Y + 3.55, -0.55),
  };

  /* ------------------------------------------------------------- frame */

  const point = new THREE.Vector3();
  function draw() {
    const dt = Math.min(clock.getDelta(), 0.05);
    if (playing) elapsed += dt;
    const t = elapsed;

    // Pointer: ease towards the target, a few degrees at most.
    pointerNow.x += (pointerTarget.x - pointerNow.x) * Math.min(1, dt * 4);
    pointerNow.y += (pointerTarget.y - pointerNow.y) * Math.min(1, dt * 4);
    rig.rotation.y = pointerNow.x * 0.16 + Math.sin(t * 0.25) * 0.03;
    rig.rotation.x = pointerNow.y * 0.08;

    // The crystal: along the crossing, bobbing, turning.
    crossing.getPointAt(THREE.MathUtils.clamp(state.u, 0, 1), point);
    ethGroup.position.copy(point);
    ethGroup.position.y += Math.sin(t * 1.6) * 0.06;
    const travelling = state.u > 0.02 && state.u < 0.98;
    eth.rotation.y = t * 0.7 + state.u * Math.PI * 3;
    eth.rotation.z = Math.sin(t * 0.9) * 0.08;
    ethMaterial.opacity = state.ethOpacity;
    ethMaterial.transparent = state.ethOpacity < 0.999;
    ethGlow.material.opacity = (theme === 'dark' ? 0.45 : 0.18) * state.ethOpacity;
    ethGroup.scale.setScalar(0.6 + 0.4 * state.ethOpacity);

    // Debt coins orbit their dial.
    const orbit = (holder: THREE.Group, scale: number, phase: number) => {
      holder.visible = scale > 0.01;
      const angle = t * 0.9 + phase;
      const r = DIAL_RADIUS * 0.78;
      holder.position.set(Math.cos(angle) * r * scale, Math.sin(angle) * r * scale, 0.35);
      holder.scale.setScalar(Math.max(0.001, scale));
      holder.rotation.y = Math.sin(t * 1.4 + phase) * 0.6;
    };
    orbit(oldDebt, state.oldDebt, 0);
    orbit(newDebt, state.newDebt, Math.PI);

    // Arcs: the source drains as its debt is repaid, the destination fills as its loan opens.
    setArcFill(sourceDial, state.oldDebt);
    setArcFill(destinationDial, Math.max(state.newDebt, 0));
    const p = PALETTE[theme];
    // Amber reads brighter than teal at the same opacity, so it is held back.
    sourceDial.glow.material.opacity = p.glowOpacity * 0.6 * (0.25 + 0.75 * state.oldDebt);
    destinationDial.glow.material.opacity = p.glowOpacity * (0.2 + 0.8 * state.destLit);
    destinationDial.track.material.opacity = 0.6 + 0.4 * state.destLit;

    // The beam brightens while value crosses, with a bright head on the crystal.
    beamUniforms.uTime.value = t;
    beamUniforms.uStrength.value = state.beam;
    beamUniforms.uHead.value = travelling ? state.u : -1;

    // NEAR Intents carries the collateral: the coin spins up as it passes.
    const passing = travelling ? Math.max(0, 1 - Math.abs(state.u - 0.5) / 0.32) : 0;
    nearSpin += dt * (0.6 + passing * 9);
    nearMesh.rotation.z = 0;
    near.rotation.y = Math.sin(t * 0.8) * 0.35 + (playing ? nearSpin : 0);
    near.position.y = NEAR_POINT.y + Math.sin(t * 1.3 + 1) * 0.05;
    near.scale.setScalar(1 + passing * 0.12);
    nearGlow.material.opacity =
      (theme === 'dark' ? 0.28 : 0.14) + passing * (theme === 'dark' ? 0.45 : 0.25);
    nearEdge.emissiveIntensity = 0.18 + passing * 0.9;

    // A short trail.
    const trailMaterial = trail.material as THREE.PointsMaterial;
    trailMaterial.opacity = travelling ? 0.85 : Math.max(0, trailMaterial.opacity - dt * 2);
    for (let i = 0; i < trailCount; i += 1) {
      const q = THREE.MathUtils.clamp(state.u - (i / trailCount) * 0.16, 0, 1);
      crossing.getPointAt(q, point);
      const jitter = Math.sin(i * 12.9898 + t * 7) * 0.05;
      trailPositions[i * 3] = point.x + jitter;
      trailPositions[i * 3 + 1] = point.y + Math.cos(i * 4.1 + t * 6) * 0.05;
      trailPositions[i * 3 + 2] = point.z;
    }
    trailGeometry.attributes.position!.needsUpdate = true;

    // Drifting dust.
    dust.rotation.y = t * 0.02;

    renderer.render(scene, camera);
    placeLabel(options.labels.source, labelPoints.source);
    placeLabel(options.labels.destination, labelPoints.destination);
    placeLabel(options.labels.beam, labelPoints.beam);
  }

  let frameRequested = false;
  function loop() {
    frameRequested = false;
    if (destroyed) return;
    draw();
    if (running) {
      frameRequested = true;
      requestAnimationFrame(loop);
    }
  }
  function requestFrame() {
    if (frameRequested || destroyed) return;
    frameRequested = true;
    requestAnimationFrame(loop);
  }
  function updateRunning() {
    const shouldRun = visible && playing && !document.hidden;
    if (shouldRun && !running) {
      running = true;
      clock.getDelta();
      requestFrame();
    } else if (!shouldRun) {
      running = false;
    }
  }
  const onVisibility = () => updateRunning();
  document.addEventListener('visibilitychange', onVisibility);

  applyTheme(options.theme);
  setStage('ready', true);
  updateRunning();
  requestFrame();

  return {
    setStage,
    setTheme: applyTheme,
    setPlaying(next) {
      playing = next;
      if (!next) gsap.killTweensOf(state);
      if (!next) Object.assign(state, targetsFor(stage), { ethOpacity: 1 });
      updateRunning();
      requestFrame();
    },
    resize(w, h) {
      width = Math.max(1, w);
      height = Math.max(1, h);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      // Keep both dials in frame on narrow screens.
      camera.position.z =
        camera.aspect < 1.05 ? CAMERA_Z / Math.max(0.62, camera.aspect / 1.05) : CAMERA_Z;
      camera.updateProjectionMatrix();
      requestFrame();
    },
    pointer(x, y) {
      pointerTarget.x = THREE.MathUtils.clamp(x, -1, 1);
      pointerTarget.y = THREE.MathUtils.clamp(y, -1, 1);
      if (!running) requestFrame();
    },
    setVisible(next) {
      visible = next;
      updateRunning();
    },
    destroy() {
      destroyed = true;
      running = false;
      gsap.killTweensOf(state);
      document.removeEventListener('visibilitychange', onVisibility);
      scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        mesh.geometry?.dispose?.();
        const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material?.dispose?.();
      });
      faceMap.dispose();
      nearFaceMap.dispose();
      glowMap.dispose();
      environment.dispose();
      pmrem.dispose();
      renderer.dispose();
    },
  };
}
