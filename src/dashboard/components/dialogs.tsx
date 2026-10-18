export function Dialogs() {
  return (
    <>
      <dialog id="action-dialog" class="modal">
        <div class="modal-box max-w-lg border border-base-300 bg-base-200">
          <h2 id="action-title" class="text-lg font-semibold"></h2>
          <p
            id="action-description"
            class="mt-2 text-xs leading-5 text-base-content/50"
          >
          </p>
          <form id="action-form" class="mt-5">
            <div id="action-fields"></div>
            <p id="action-error" class="mt-3 text-xs text-error" role="alert">
            </p>
            <div class="modal-action">
              <button
                class="btn btn-sm"
                type="button"
                data-action="close-dialog"
              >
                Cancel
              </button>
              <button id="action-submit" class="btn btn-sm" type="submit">
                Save changes
              </button>
            </div>
          </form>
        </div>
        <form method="dialog" class="modal-backdrop">
          <button type="submit">Close</button>
        </form>
      </dialog>
      <dialog id="token-dialog" class="modal">
        <div class="modal-box border border-base-300 bg-base-200">
          <h2 class="text-lg font-semibold">Access credential created</h2>
          <p id="token-description" class="mt-2 text-xs text-base-content/50">
            Copy this credential now. Only its metadata is stored on the server.
          </p>
          <textarea
            id="created-token"
            class="textarea mt-4 h-36 w-full font-mono text-xs"
            readonly
            aria-label="New access token"
          >
          </textarea>
          <div class="modal-action">
            <button type="button" class="btn btn-sm" data-action="copy-token">
              Copy token
            </button>
            <form method="dialog">
              <button type="submit" class="btn btn-sm">Done</button>
            </form>
          </div>
        </div>
      </dialog>
    </>
  );
}
