// SPDX-License-Identifier: LGPL-3.0-only
export function NewRoom(props: { disabled: boolean; open: () => void }) {
  return (
    <button
      type="button"
      data-action="new-room"
      disabled={props.disabled}
      onClick={props.open}
    >
      New room
    </button>
  );
}
