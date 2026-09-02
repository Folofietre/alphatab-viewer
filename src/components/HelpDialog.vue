<template>
  <!-- A native <dialog>, opened with showModal(), which is what gives the
       backdrop, the focus trap and Escape-to-close for free. Hand-rolling those
       is how half-accessible modals happen.

       Backdrop clicks are the one thing showModal() does NOT handle: the click
       lands on the dialog element itself, since the backdrop is its pseudo
       element, so comparing the target to the dialog is how to tell them apart. -->
  <dialog ref="dialog" class="help-dialog" aria-labelledby="help-title" @click="onBackdrop" @close="closeHelp">
    <div class="sheet">
      <header>
        <h2 id="help-title">Keyboard and mouse</h2>
        <button type="button" class="close" aria-label="Close the help" @click="closeHelp">&times;</button>
      </header>

      <div class="body">
        <!-- Generated from the binding table, so it cannot claim a shortcut the
             handler does not have - the GROUPS included, so a key cannot end up
             filed under the wrong heading either.

             Laid out in columns rather than as one list: the table is long
             enough now that "what does the dot do" means scanning thirty rows,
             where four headed groups means scanning one. -->
        <section class="keyboard">
          <div v-for="section in shortcuts" :key="section.group" class="group">
            <h3>{{ section.group }}</h3>
            <dl>
              <template v-for="row in section.rows" :key="row.label">
                <dt>
                  <template v-for="(keys, i) in row.keys" :key="keys">
                    <span v-if="i > 0" class="alt">or</span>
                    <kbd>{{ keys }}</kbd>
                  </template>
                </dt>
                <dd>{{ row.label }}</dd>
              </template>
            </dl>
          </div>
        </section>

        <!-- Hand-written, because these are not bindings: alphaTab owns the
             mouse and there is no table to generate them from. -->
        <section class="mouse">
          <h3>Mouse</h3>
          <dl>
            <dt><span class="gesture">Click a note head</span></dt>
            <dd>Select that note. It is ringed on every staff it is drawn on.</dd>

            <dt><span class="gesture">Double click a bar</span></dt>
            <dd>
              Select every note of that measure, on the track you clicked, and set
              it as the loop range.
            </dd>

            <dt><span class="gesture">Click and drag</span></dt>
            <dd>
              Select a passage on the track the drag started on, and set it as the
              loop range. Every note in it is ringed.
            </dd>

            <dt><span class="gesture">Click a bar, off any note</span></dt>
            <dd>
              Move the playhead there, and put the cursor on the string you
              clicked - marked with a dashed outline. The arrow keys move it from
              there.
            </dd>

            <dt><span class="gesture">Click a track name</span></dt>
            <dd>In the Mixer tab, show that track alone.</dd>

            <dt><span class="gesture">Any click on the score</span></dt>
            <dd>
              Takes the keyboard back from whatever field or menu had it, so the
              keys above act on the score rather than on a control you had just
              used.
            </dd>
          </dl>
        </section>
      </div>

      <footer>
        Editing is only possible while <strong>paused</strong>. Every operation is
        all or nothing: if one note would run off the neck, the whole selection is
        refused with the numbers rather than clamped.
      </footer>
    </div>
  </dialog>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { useHelp } from '@/composables/useHelp'
import { shortcutHelp } from '@/composables/useShortcuts'

const dialog = ref(null)
const { isHelpOpen, closeHelp } = useHelp()

// Derived once: the binding table does not change at runtime.
const shortcuts = computed(() => shortcutHelp())

// The open state lives in the composable, so the element is driven from it
// rather than the other way round. `close()` fires the `close` event, which
// calls closeHelp() again - harmless, since it only sets a ref that is already
// false.
watch(isHelpOpen, (open) => {
  const el = dialog.value
  if (!el) return
  if (open && !el.open) el.showModal()
  else if (!open && el.open) el.close()
})

// The backdrop is the dialog's own pseudo element, so a click on it reports the
// DIALOG as its target. Anything inside reports a child, which is what separates
// "clicked outside" from "clicked the sheet".
function onBackdrop(event) {
  if (event.target === dialog.value) closeHelp()
}
</script>

<style scoped lang="scss" src="@/styles/components/HelpDialog.scss"></style>
