/**
 * The modal slot is empty unless a card route is being intercepted. Without
 * this file a hard navigation to any other page has nothing to render in the
 * slot and the route 404s.
 */
export default function ModalSlotDefault() {
  return null;
}
