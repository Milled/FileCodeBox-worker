import encodeQR from 'qr';

/** 生成 QR 码 GIF（零依赖 qr 包，输出即 Uint8Array，Worker 兼容） */
export function generateQRCodeGIF(data: string, size: number = 200): Uint8Array {
  return encodeQR(data, 'gif', { scale: Math.max(1, Math.floor(size / 29)) });
}
