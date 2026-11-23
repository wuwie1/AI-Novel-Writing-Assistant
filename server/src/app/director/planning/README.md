# Saved chapter planning

Use `directorVolumeChapterPlanFilter` for director reads and confirmations of relational volume and chapter plans. Automatic volume planning uses `active`. Adopted outlines preserve `chapter_list_partial` or `chapter_list_generated`. Partially generated routes may also retain their base state.

Legacy volumes marked `planned` or `chapter_list_partial:planned` qualify when their source version is active and belongs to the same novel. Execution sync also matches the source version against the workspace snapshot, since a version switch can preserve chapter IDs.

Archived and other stale volume states are excluded. Callers still validate the exact chapter order, selected volume, and uniqueness; this filter does not choose a first match or infer a missing plan.
