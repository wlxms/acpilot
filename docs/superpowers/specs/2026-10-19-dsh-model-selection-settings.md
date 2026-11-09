# DSH model selection and settings design

## Problem

The DSH language-model provider starts its backend while VS Code is only asking for model information. A missing or unresolved DSH command therefore turns a model-list refresh into an empty vendor, so the Agent picker reports that DeepSeek Harness has no models.

## Behavior

- Every backend language-model provider always exposes one static `Auto` model.
- Model-information queries never start a stopped backend.
- Real backend models are listed only when that backend is already running and its catalog can be refreshed.
- Selecting `Auto` starts the backend when needed, refreshes its model catalog, and routes the request to the first current backend model.
- If startup or discovery fails, `Auto` remains visible and the request reports the actual failure.
- The settings model picker always includes `Auto`; choosing it follows the same start-and-refresh path and then selects the discovered default model.
- DSH settings expose an explicit Start DSH action, keep custom command, startup directory, endpoint, arguments, install directory, package spec, and install/update operations, and remove the DSH Delete target action.
- DSH settings show runtime status so users can distinguish saved configuration from a running process.

## Scope

The existing DSH target persistence and custom launch resolver remain the compatibility layer. This change removes the DSH delete button and message path from the UI, while preserving stored targets for existing installations and future multi-target support.
