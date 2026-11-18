struct GridUniforms {
  viewForward: vec4<f32>,
  viewRightScaled: vec4<f32>,
  viewUpScaled: vec4<f32>,
  upAxis: vec4<f32>,
  gridRight: vec4<f32>,
  gridForward: vec4<f32>,
  params: vec4<f32>,
  phase: vec4<f32>,
  lineColor: vec4<f32>,
};
@group(0) @binding(0) var<uniform> u: GridUniforms;

struct VertexOut {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) ndc: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOut {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0),
  );
  var out: VertexOut;
  let p = positions[vertexIndex];
  out.clipPosition = vec4<f32>(p, 0.0, 1.0);
  out.ndc = p;
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  let orthographic = u.params.w > 0.5;
  var dir = normalize(u.viewForward.xyz);
  var rayOrigin = vec3<f32>(0.0, 0.0, 0.0);
  if (orthographic) {
    rayOrigin = in.ndc.x * u.viewRightScaled.xyz + in.ndc.y * u.viewUpScaled.xyz;
  } else {
    dir = normalize(u.viewForward.xyz + in.ndc.x * u.viewRightScaled.xyz + in.ndc.y * u.viewUpScaled.xyz);
  }
  let up = normalize(u.upAxis.xyz);

  let relGroundHeight = u.params.x;
  let cellSize = u.params.y;
  let fadeDistance = u.params.z;

  let denom = dot(dir, up);
  if (abs(denom) < 1e-6) {
    discard;
  }
  let t = (relGroundHeight - dot(rayOrigin, up)) / denom;
  if (t <= 0.0 && !orthographic) {
    discard;
  }

  let hitRel = rayOrigin + dir * t;
  let hitU = dot(hitRel, u.gridRight.xyz);
  let hitV = dot(hitRel, u.gridForward.xyz);

  let uCoord = (u.phase.x + hitU) / cellSize;
  let vCoord = (u.phase.y + hitV) / cellSize;

  let du = max(fwidth(uCoord), 1e-6);
  let dv = max(fwidth(vCoord), 1e-6);
  let lineU = 1.0 - min(abs(fract(uCoord - 0.5) - 0.5) / du, 1.0);
  let lineV = 1.0 - min(abs(fract(vCoord - 0.5) - 0.5) / dv, 1.0);
  let intensity = max(lineU, lineV);

  let dist = select(length(hitRel), length(rayOrigin), orthographic);
  let fade = 1.0 - smoothstep(fadeDistance * 0.5, fadeDistance, dist);

  let alpha = intensity * fade * u.lineColor.a;
  if (alpha <= 0.001) {
    discard;
  }
  return vec4<f32>(u.lineColor.rgb, alpha);
}
