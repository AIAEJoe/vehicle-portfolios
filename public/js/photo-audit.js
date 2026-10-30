// Merchandising audit for a car's photos, scored against the dealership's photo standard (Settings → minimum
// photos, 6 by default). Pure function, shared by the Photos page, the vehicle page and the vehicles list.
//
// Score out of 100: photos 70 (count vs the minimum), captions 15 (share of photos with a caption), comments 15
// (a vehicle description of at least 100 characters). The shot list and caption standard aren't set yet; when they
// are, they slot in here.
export const DEFAULT_PHOTO_MIN = 6;

export function auditPhotos(v, photos, min = DEFAULT_PHOTO_MIN) {
  const list = photos || [];
  const count = list.length;
  const real = list.filter((p) => p.source === 'upload').length;
  const captioned = list.filter((p) => String(p.caption || '').trim()).length;
  const desc = String((v && v.description) || '').trim();
  const photoPts = Math.round(70 * Math.min(1, count / Math.max(1, min)));
  const captionPts = count ? Math.round(15 * (captioned / count)) : 0;
  const commentPts = desc.length >= 100 ? 15 : desc.length >= 30 ? 7 : 0;
  const issues = [];
  if (count < min) issues.push(`${min - count} more photo${min - count === 1 ? '' : 's'} needed (minimum ${min})`);
  if (!real && count) issues.push('No photos from your photographer yet (only stock or feed photos)');
  if (count && captioned < count) issues.push(`${count - captioned} photo${count - captioned === 1 ? '' : 's'} without a caption`);
  if (desc.length < 100) issues.push(desc ? 'Description is short (under 100 characters)' : 'No description');
  return { count, min, real, captioned, meetsMinimum: count >= min, score: photoPts + captionPts + commentPts, issues };
}
