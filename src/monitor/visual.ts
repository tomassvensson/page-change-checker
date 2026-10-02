export interface IgnoredRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Ignore declared normalized regions in the comparison signature only. The
 * original screenshot is never altered, covered, or used as a grey overlay. */
export function maskSignature(
  signature: { width: number; height: number; pixels: string },
  regions: IgnoredRegion[]
) {
  const pixels = Buffer.from(signature.pixels, 'base64');
  if (pixels.length !== signature.width * signature.height * 3)
    throw new Error('Invalid signature dimensions');
  for (const region of regions) {
    if (
      ![region.x, region.y, region.width, region.height].every(
        (value) => Number.isFinite(value) && value >= 0 && value <= 1
      ) ||
      region.x + region.width > 1 ||
      region.y + region.height > 1
    )
      throw new Error('Invalid ignored comparison region');
    for (
      let y = Math.floor(region.y * signature.height);
      y < Math.ceil((region.y + region.height) * signature.height);
      y++
    ) {
      for (
        let x = Math.floor(region.x * signature.width);
        x < Math.ceil((region.x + region.width) * signature.width);
        x++
      )
        pixels.fill(0, (y * signature.width + x) * 3, (y * signature.width + x + 1) * 3);
    }
  }
  return { ...signature, pixels: pixels.toString('base64') };
}
