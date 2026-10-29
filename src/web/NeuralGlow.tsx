import { useEffect, useRef } from 'react';

const vertexSource = `
  attribute vec2 a_position;
  varying vec2 v_uv;
  void main() {
    v_uv = .5 * (a_position + 1.);
    gl_Position = vec4(a_position, 0., 1.);
  }
`;

// Adapted from the supplied Neural Glow example; alpha leaves the photo visible.
const fragmentSource = `
  precision mediump float;
  varying vec2 v_uv;
  uniform float u_time;
  uniform float u_ratio;
  uniform vec2 u_pointer;

  vec2 rotate(vec2 value, float angle) {
    return mat2(cos(angle), sin(angle), -sin(angle), cos(angle)) * value;
  }

  float neuroShape(vec2 uv, float time, float influence) {
    vec2 sineAcc = vec2(0.);
    vec2 result = vec2(0.);
    float scale = 8.;
    for (int i = 0; i < 15; i++) {
      uv = rotate(uv, 1.);
      sineAcc = rotate(sineAcc, 1.);
      vec2 layer = uv * scale + float(i) + sineAcc - time;
      sineAcc += sin(layer) + 2.4 * influence;
      result += (.5 + .5 * cos(layer)) / scale;
      scale *= 1.2;
    }
    return result.x + result.y;
  }

  void main() {
    vec2 uv = .5 * v_uv;
    uv.x *= u_ratio;
    vec2 distanceToPointer = v_uv - u_pointer;
    distanceToPointer.x *= u_ratio;
    float influence = .5 * pow(1. - clamp(length(distanceToPointer), 0., 1.), 2.);
    float noise = neuroShape(uv, u_time * .001, influence);
    noise = max(0., 1.2 * pow(noise, 3.) + pow(noise, 10.) - .5);
    noise *= max(0., 1. - length(v_uv - .5));
    gl_FragColor = vec4(vec3(1.), clamp(noise * .26, 0., .32));
  }
`;

function compile(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn('Neural Glow shader:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export function NeuralGlow() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let dispose = () => {};

    function start() {
      if (!canvas) return;
      const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false, antialias: false });
      if (!gl) return;
      const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource);
      const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
      if (!vertex || !fragment) {
        if (vertex) gl.deleteShader(vertex);
        if (fragment) gl.deleteShader(fragment);
        return;
      }
      const program = gl.createProgram();
      const buffer = gl.createBuffer();
      if (!program || !buffer) {
        if (program) gl.deleteProgram(program);
        if (buffer) gl.deleteBuffer(buffer);
        gl.deleteShader(vertex);
        gl.deleteShader(fragment);
        return;
      }
      gl.attachShader(program, vertex);
      gl.attachShader(program, fragment);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.warn('Neural Glow program:', gl.getProgramInfoLog(program));
        gl.deleteBuffer(buffer);
        gl.deleteProgram(program);
        gl.deleteShader(vertex);
        gl.deleteShader(fragment);
        return;
      }
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const position = gl.getAttribLocation(program, 'a_position');
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      const time = gl.getUniformLocation(program, 'u_time');
      const ratio = gl.getUniformLocation(program, 'u_ratio');
      const pointer = gl.getUniformLocation(program, 'u_pointer');
      let x = 0.5,
        y = 0.5,
        targetX = 0.5,
        targetY = 0.5;
      let frame = 0;

      const resize = () => {
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.25);
        canvas.width = Math.round(window.innerWidth * pixelRatio);
        canvas.height = Math.round(window.innerHeight * pixelRatio);
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.uniform1f(ratio, canvas.width / canvas.height);
      };
      const move = (event: PointerEvent) => {
        targetX = event.clientX / window.innerWidth;
        targetY = 1 - event.clientY / window.innerHeight;
        if (reduced.matches) render(0);
      };
      const render = (timestamp: number) => {
        x += (targetX - x) * (reduced.matches ? 1 : 0.12);
        y += (targetY - y) * (reduced.matches ? 1 : 0.12);
        gl.uniform1f(time, timestamp);
        gl.uniform2f(pointer, x, y);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        if (!reduced.matches) frame = requestAnimationFrame(render);
      };
      const visibility = () => {
        cancelAnimationFrame(frame);
        if (!document.hidden) reduced.matches ? render(0) : (frame = requestAnimationFrame(render));
      };
      resize();
      window.addEventListener('resize', resize);
      window.addEventListener('pointermove', move, { passive: true });
      window.addEventListener('pointerdown', move, { passive: true });
      document.addEventListener('visibilitychange', visibility);
      if (!document.hidden) reduced.matches ? render(0) : (frame = requestAnimationFrame(render));
      dispose = () => {
        cancelAnimationFrame(frame);
        window.removeEventListener('resize', resize);
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerdown', move);
        document.removeEventListener('visibilitychange', visibility);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.deleteBuffer(buffer);
        gl.deleteProgram(program);
        gl.deleteShader(vertex);
        gl.deleteShader(fragment);
      };
    }

    const onPreferenceChange = () => {
      dispose();
      dispose = () => {};
      start();
    };
    reduced.addEventListener('change', onPreferenceChange);
    start();
    return () => {
      reduced.removeEventListener('change', onPreferenceChange);
      dispose();
    };
  }, []);

  return <canvas ref={canvasRef} className="neural-glow" aria-hidden="true" />;
}
