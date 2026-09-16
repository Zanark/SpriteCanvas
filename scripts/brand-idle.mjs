import { validateProject } from '../web/lib/model.js';
import { encodeGif } from '../web/lib/gif.js';

export function idleBrandAssets(source) {
  const project = validateProject(source);
  if (project.frames.length < 2 || project.width !== project.height) {
    throw new Error('The README idle logo must be a square, animated pixel project.');
  }
  const matte = { id: 'readme-gif-matte', name: 'GIF-only dark presentation matte', visible: true, locked: false, opacity: 1 };
  // GIF cannot retain partial alpha; matte only the derived export, never its editable source.
  const gifProject = {
    ...project, layers: [matte, ...project.layers],
    frames: project.frames.map(frame => ({
      ...frame, cels: { ...frame.cels, [matte.id]: Array(project.width * project.height).fill('#1E2125FF') },
    })),
  };
  return { gif: encodeGif(gifProject, 16), gifProject };
}
