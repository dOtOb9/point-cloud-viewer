struct Uniforms {
  mvp: mat4x4<f32>,
  pointSizePx: f32,
  viewportWidth: f32,
  viewportHeight: f32,
  originZ: f32,
  fade: f32,
};
@group(0) @binding(0) var<uniform> u: Uniforms;

struct ColorSettings {
  mode: f32,
  elevationMin: f32,
  elevationMax: f32,
  intensityMin: f32,
  intensityMax: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
};
@group(0) @binding(1) var<uniform> cs: ColorSettings;

struct VertexIn {
  @builtin(vertex_index) vertexIndex: u32,
  @location(0) position: vec3<f32>,
  @location(1) color: vec4<f32>,
  @location(2) packed: u32,
};

struct VertexOut {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) uv: vec2<f32>,
  @location(2) @interpolate(flat) fade: f32,
};


fn classificationColor(code: u32) -> vec3<f32> {
  switch code {
    case 0u:  { return vec3<f32>(0.6, 0.6, 0.6); }
    case 1u:  { return vec3<f32>(0.78, 0.78, 0.78); }
    case 2u:  { return vec3<f32>(0.55, 0.4, 0.22); }
    case 3u:  { return vec3<f32>(0.62, 0.82, 0.35); }
    case 4u:  { return vec3<f32>(0.32, 0.66, 0.28); }
    case 5u:  { return vec3<f32>(0.1, 0.42, 0.16); }
    case 6u:  { return vec3<f32>(0.85, 0.32, 0.22); }
    case 7u:  { return vec3<f32>(1.0, 0.0, 1.0); }
    case 8u:  { return vec3<f32>(0.5, 0.5, 0.5); }
    case 9u:  { return vec3<f32>(0.15, 0.4, 0.85); }
    case 10u: { return vec3<f32>(0.4, 0.4, 0.45); }
    case 11u: { return vec3<f32>(0.25, 0.25, 0.28); }
    case 12u: { return vec3<f32>(0.58, 0.58, 0.58); }
    case 13u: { return vec3<f32>(0.8, 0.6, 0.1); }
    case 14u: { return vec3<f32>(0.9, 0.72, 0.2); }
    case 15u: { return vec3<f32>(0.7, 0.42, 0.12); }
    case 16u: { return vec3<f32>(0.82, 0.55, 0.32); }
    case 17u: { return vec3<f32>(0.62, 0.32, 0.7); }
    case 18u: { return vec3<f32>(1.0, 0.15, 0.15); }
    default:  { return vec3<f32>(0.0, 0.9, 0.9); }
  }
}

fn colorForVertex(in: VertexIn) -> vec4<f32> {
  let mode = i32(round(cs.mode));
  let intensityRaw = in.packed & 0xffffu;
  let classificationRaw = (in.packed >> 16u) & 0xffu;

  if (mode == 1) {
    let worldZ = u.originZ + in.position.z;
    let range = cs.elevationMax - cs.elevationMin;
    var t = 0.0;
    if (range > 0.0) {
      t = clamp((worldZ - cs.elevationMin) / range, 0.0, 1.0);
    }
    return vec4<f32>(elevationOrIntensityRampColor(t), in.color.a);
  }
  if (mode == 2) {
    let range = cs.intensityMax - cs.intensityMin;
    var t = 0.0;
    if (range > 0.0) {
      t = clamp((f32(intensityRaw) - cs.intensityMin) / range, 0.0, 1.0);
    }
    return vec4<f32>(elevationOrIntensityRampColor(t), in.color.a);
  }
  if (mode == 3) {
    return vec4<f32>(classificationColor(classificationRaw), in.color.a);
  }
  return in.color;
}

@vertex
fn vs_main(in: VertexIn) -> VertexOut {
  var corners = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0),
  );
  let corner = corners[in.vertexIndex];

  let clip = u.mvp * vec4<f32>(in.position, 1.0);

  let ndcHalf = vec2<f32>(u.pointSizePx / u.viewportWidth, u.pointSizePx / u.viewportHeight);

  var out: VertexOut;
  out.clipPosition = vec4<f32>(clip.xy + corner * ndcHalf * clip.w, clip.z, clip.w);
  out.color = colorForVertex(in);
  out.uv = corner;
  out.fade = u.fade;
  return out;
}

@fragment
fn fs_main_round(in: VertexOut) -> @location(0) vec4<f32> {
  if (dot(in.uv, in.uv) > 1.0) {
    discard;
  }
  return in.color;
}

@fragment
fn fs_main_square(in: VertexOut) -> @location(0) vec4<f32> {
  return in.color;
}

fn bayer4(p: vec2<u32>) -> f32 {
  var m = array<f32, 16>(
     0.0,  8.0,  2.0, 10.0,
    12.0,  4.0, 14.0,  6.0,
     3.0, 11.0,  1.0,  9.0,
    15.0,  7.0, 13.0,  5.0,
  );
  let i = (p.y & 3u) * 4u + (p.x & 3u);
  return (m[i] + 0.5) / 16.0;
}

@fragment
fn fs_main_round_fade(in: VertexOut) -> @location(0) vec4<f32> {
  if (dot(in.uv, in.uv) > 1.0) {
    discard;
  }
  if (in.fade <= bayer4(vec2<u32>(in.clipPosition.xy))) {
    discard;
  }
  return in.color;
}

@fragment
fn fs_main_square_fade(in: VertexOut) -> @location(0) vec4<f32> {
  if (in.fade <= bayer4(vec2<u32>(in.clipPosition.xy))) {
    discard;
  }
  return in.color;
}
