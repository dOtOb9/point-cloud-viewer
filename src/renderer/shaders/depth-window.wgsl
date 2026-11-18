struct Params {
  x0: i32,
  y0: i32,
  size: u32,
  pad: u32,
}
@group(0) @binding(0) var depthTex: texture_depth_2d;
@group(0) @binding(1) var<storage, read_write> outDepth: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;

@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= params.size || gid.y >= params.size) {
    return;
  }
  let dims = vec2<i32>(textureDimensions(depthTex));
  let p = vec2<i32>(params.x0 + i32(gid.x), params.y0 + i32(gid.y));
  var d = 1.0;
  if (p.x >= 0 && p.y >= 0 && p.x < dims.x && p.y < dims.y) {
    d = textureLoad(depthTex, p, 0);
  }
  outDepth[gid.y * params.size + gid.x] = d;
}
