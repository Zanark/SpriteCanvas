import { validateProject } from '../web/lib/model.js';
import { encodeGif } from '../web/lib/gif.js';

export function idleBrandAssets(source) {
  const project = validateProject(source);
  if (project.frames.length < 2 || project.width !== project.height) {
    throw new Error('The README idle logo must be a square, animated pixel project.');
  }
  return { gif: encodeGif(project, 16, { alphaMode: 'dither' }), gifProject: project };
}
