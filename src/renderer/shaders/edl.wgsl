struct EdlUniforms {
  strength: f32,
  radiusPx: f32,
  near: f32,
  far: f32,
  viewportWidth: f32,
  viewportHeight: f32,
  orthoRef: f32,
  _pad1: f32,
};
@group(0) @binding(0) var<uniform> u: EdlUniforms;
@group(0) @binding(1) var pointColor: texture_2d<f32>;
@group(0) @binding(2) var pointDepth: texture_depth_2d;

struct VertexOut {
  @builtin(position) clipPosition: vec4<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOut {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0),
  );
  var out: VertexOut;
  out.clipPosition = vec4<f32>(positions[vertexIndex], 0.0, 1.0);
  return out;
}

fn linearizeDepth(ndcDepth: f32) -> f32 {
  return (u.near * u.far) / (u.far - ndcDepth * (u.far - u.near));
}

fn logDepth(ndcDepth: f32) -> f32 {
  if (u.orthoRef > 0.0) {
    let eyeDistance = u.near + ndcDepth * (u.far - u.near);
    return eyeDistance / (u.orthoRef * 0.6931472);
  }
  return log2(linearizeDepth(ndcDepth));
}

@fragment
fn fs_main(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
  let dims = vec2<i32>(textureDimensions(pointDepth));
  let coord = vec2<i32>(i32(fragCoord.x), i32(fragCoord.y));

  let ownDepthNdc = textureLoad(pointDepth, coord, 0);
  if (ownDepthNdc >= 1.0) {
    discard;
  }

  let color = textureLoad(pointColor, coord, 0);
  let ownLog = logDepth(ownDepthNdc);

  var neighbourOffsets = array<vec2<f32>, 8>(
    vec2<f32>(1.0, 0.0), vec2<f32>(-1.0, 0.0), vec2<f32>(0.0, 1.0), vec2<f32>(0.0, -1.0),
    vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, -1.0),
  );

  var responseSum: f32 = 0.0;
  for (var i = 0; i < 8; i = i + 1) {
    let offset = vec2<i32>(round(neighbourOffsets[i] * u.radiusPx));
    let neighbourCoord = clamp(coord + offset, vec2<i32>(0, 0), dims - vec2<i32>(1, 1));
    let neighbourDepthNdc = textureLoad(pointDepth, neighbourCoord, 0);
    if (neighbourDepthNdc < 1.0) {
      responseSum = responseSum + max(0.0, ownLog - logDepth(neighbourDepthNdc));
    }
  }
  let response = responseSum / 8.0;

  let shade = max(EDL_MIN_SHADE, exp(-response * EDL_RESPONSE_SCALE * u.strength));

  return vec4<f32>(color.rgb * shade, 1.0);
}
