struct SkyUniforms {
  forward: vec4<f32>,
  rightScaled: vec4<f32>,
  upScaled: vec4<f32>,
  upAxis: vec4<f32>,
  zenithColor: vec4<f32>,
  horizonColor: vec4<f32>,
  groundColor: vec4<f32>,
  horizonLineColor: vec4<f32>,
};
@group(0) @binding(0) var<uniform> u: SkyUniforms;

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
  let dir = normalize(u.forward.xyz + in.ndc.x * u.rightScaled.xyz + in.ndc.y * u.upScaled.xyz);

  let up = normalize(u.upAxis.xyz);
  let t = dot(dir, up);

  var color: vec3<f32>;
  if (t >= 0.0) {
    let k = pow(clamp(t, 0.0, 1.0), 0.7);
    color = mix(u.horizonColor.rgb, u.zenithColor.rgb, k);
  } else {
    let k = clamp(-t, 0.0, 1.0);
    color = mix(u.horizonColor.rgb, u.groundColor.rgb, k);
  }

  let lineWidth = max(fwidth(t), 0.0005) * 1.5;
  let lineFactor = 1.0 - smoothstep(0.0, lineWidth, abs(t));
  color = mix(color, u.horizonLineColor.rgb, lineFactor);

  return vec4<f32>(color, 1.0);
}
