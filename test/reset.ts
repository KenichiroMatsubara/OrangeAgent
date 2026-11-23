import { afterEach } from 'vitest';

/**
 * Puts back what one test leaves behind, after every test.
 *
 * The suite runs every file of a worker in one module graph, so a hook that a
 * shared helper registered when it was first imported runs for that file
 * only. What every test needs is therefore registered here, where it runs
 * for each file: in a DOM test the rendered trees are unmounted and the
 * storage the page kept is emptied, and in every test what a module keeps
 * for as long as its page or isolate lives is forgotten, so no test passes
 * or fails by what an earlier one left there. CI runs the suite in a random
 * order to find any such state that is not yet forgotten here.
 */
afterEach(async () => {
  if (typeof document === 'undefined') {
    // What the Worker keeps for as long as its isolate lives: OpenRouter's list of models.
    const { forgetOpenRouterModels } = await import('../apps/worker/src/effort');
    forgetOpenRouterModels();
    return;
  }
  const { cleanup } = await import('@testing-library/react');
  cleanup();
  // What the chat keeps for as long as the page lives: where each conversation was scrolled, which calls were open.
  const { forgetTimelinePositions } = await import('../packages/t3chat/src/web/components/chat/timelineScrollAnchoring');
  forgetTimelinePositions();
  // …and what each conversation's composer holds unsent.
  const { useComposerDraftStore } = await import('../packages/t3chat/src/web/composerDraftStore');
  useComposerDraftStore.setState(useComposerDraftStore.getInitialState(), true);
  document.body.innerHTML = '';
  localStorage.clear();
  sessionStorage.clear();
});
