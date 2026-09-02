<template>
  <!-- Purely visual, and deliberately so. A tooltip is invisible until hovered,
       so without something saying "there is more here" the help is not moved,
       it is deleted. The trigger itself is `v-help` on the surrounding field or
       header, so this marker needs no attribute of its own and hovering the
       input beside it answers just the same. -->
  <span class="help-tip" aria-hidden="true">?</span>
</template>

<style scoped lang="scss" src="@/styles/components/HelpTip.scss"></style>
