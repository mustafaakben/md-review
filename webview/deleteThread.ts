/** Shared two-click confirmation for deleting submitted/resolved threads. */
export function confirmThreadDelete(button: HTMLButtonElement, id: string, status: string, label = 'Delete'): boolean {
  if (status === 'draft' || button.dataset.deleteId === id) return true;
  button.dataset.deleteId = id;
  button.textContent = 'Delete thread?';
  button.setAttribute('aria-label', 'Confirm delete thread and its replies');
  setTimeout(() => {
    delete button.dataset.deleteId;
    button.textContent = label;
    button.removeAttribute('aria-label');
  }, 4000);
  return false;
}
