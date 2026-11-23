// AIT-610 r4: the child decodes a Buffer VIEW over the bytes it received over
// IPC. Buffer.from(typedArray) would copy the original once more (up to 20 MiB).
export const decoderInput = bytes => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
