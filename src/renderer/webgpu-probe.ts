// WebView2 上で WebGPU が使えるかを実測するためのプローブ。M0-2 用。
// このファイルは React を知らない。canvas と DOM API だけを扱う。

export type WebGpuProbeResult =
  | {
      supported: true;
      vendor: string;
      architecture: string;
      device: string;
      description: string;
    }
  | {
      supported: false;
      reason: string;
    };

/** navigator.gpu の有無と requestAdapter() の成否を確認する。 */
export async function probeWebGpu(): Promise<WebGpuProbeResult> {
  if (!("gpu" in navigator) || navigator.gpu === undefined) {
    return { supported: false, reason: "navigator.gpu が存在しない" };
  }

  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      return { supported: false, reason: "requestAdapter() が null を返した" };
    }

    const info = adapter.info;
    return {
      supported: true,
      vendor: info?.vendor || "(unknown)",
      architecture: info?.architecture || "(unknown)",
      device: info?.device || "(unknown)",
      description: info?.description || "(unknown)",
    };
  } catch (e) {
    return { supported: false, reason: `requestAdapter() が例外を投げた: ${String(e)}` };
  }
}

/**
 * 採用可否確認のため、WebGPU で三角形を1枚描画する。
 * 成功したら true、途中で失敗したら false を返す（例外は投げない）。
 */
export async function drawWebGpuTriangle(canvas: HTMLCanvasElement): Promise<boolean> {
  if (!("gpu" in navigator) || navigator.gpu === undefined) {
    return false;
  }

  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return false;
    const device = await adapter.requestDevice();

    const context = canvas.getContext("webgpu");
    if (!context) return false;

    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: "opaque" });

    const shaderModule = device.createShaderModule({
      code: `
        @vertex
        fn vs_main(@builtin(vertex_index) idx: u32) -> @builtin(position) vec4<f32> {
          var positions = array<vec2<f32>, 3>(
            vec2<f32>( 0.0,  0.6),
            vec2<f32>(-0.6, -0.6),
            vec2<f32>( 0.6, -0.6),
          );
          return vec4<f32>(positions[idx], 0.0, 1.0);
        }

        @fragment
        fn fs_main() -> @location(0) vec4<f32> {
          return vec4<f32>(0.2, 0.8, 0.4, 1.0);
        }
      `,
    });

    const pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module: shaderModule, entryPoint: "vs_main" },
      fragment: { module: shaderModule, entryPoint: "fs_main", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    });

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    pass.setPipeline(pipeline);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);

    return true;
  } catch (e) {
    console.error("drawWebGpuTriangle failed", e);
    return false;
  }
}

/** WebGL2 フォールバックとして、赤い点を1つ描画する。 */
export function drawWebGl2Point(canvas: HTMLCanvasElement): boolean {
  const gl = canvas.getContext("webgl2");
  if (!gl) return false;

  const vertexSrc = `#version 300 es
    void main() {
      gl_Position = vec4(0.0, 0.0, 0.0, 1.0);
      gl_PointSize = 20.0;
    }
  `;
  const fragmentSrc = `#version 300 es
    precision mediump float;
    out vec4 outColor;
    void main() {
      outColor = vec4(0.9, 0.3, 0.3, 1.0);
    }
  `;

  const vertexShader = gl.createShader(gl.VERTEX_SHADER);
  const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER);
  if (!vertexShader || !fragmentShader) return false;

  gl.shaderSource(vertexShader, vertexSrc);
  gl.compileShader(vertexShader);
  gl.shaderSource(fragmentShader, fragmentSrc);
  gl.compileShader(fragmentShader);

  const program = gl.createProgram();
  if (!program) return false;
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error("WebGL2 program link failed", gl.getProgramInfoLog(program));
    return false;
  }

  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(program);
  gl.drawArrays(gl.POINTS, 0, 1);

  return true;
}
