package com.verbatim.helper.ui.newnote

import android.app.Application
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import coil.compose.AsyncImage
import com.verbatim.helper.data.VerbatimRepository
import com.verbatim.helper.data.model.SearchResult
import com.verbatim.helper.ui.components.EmptyState
import com.verbatim.helper.ui.components.PrimaryButton
import com.verbatim.helper.ui.components.TopBar
import com.verbatim.helper.ui.theme.Shape
import com.verbatim.helper.ui.theme.Space
import com.verbatim.helper.ui.theme.VerbatimText
import com.verbatim.helper.ui.theme.VerbatimTheme
import com.verbatim.helper.ui.theme.pressScale
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class NewNoteViewModel(app: Application) : AndroidViewModel(app) {
    private val repo = VerbatimRepository.get(app)

    var query by mutableStateOf("")
        private set
    var results by mutableStateOf<List<SearchResult>>(emptyList())
        private set
    var loading by mutableStateOf(false)
        private set
    var creating by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    /** True once a search has actually returned, so "no results" isn't shown before searching. */
    var searched by mutableStateOf(false)
        private set

    private var searchJob: Job? = null

    val looksLikeLink: Boolean
        get() = query.trim().let { it.contains("youtu", true) || it.startsWith("http", true) }

    /**
     * Search as the user types, debounced.
     *
     * Search previously only ran on an explicit tap or keyboard action, which on a search-first
     * screen means most people type a title and then sit looking at an empty page wondering what
     * they missed. Typing is the trigger now; the debounce is what keeps that from spending a
     * YouTube API quota unit per keystroke.
     */
    fun onQueryChange(value: String) {
        query = value
        searchJob?.cancel()
        val q = value.trim()
        if (q.isEmpty() || looksLikeLink) {
            // A pasted link isn't a search term — the Create button handles it.
            results = emptyList(); searched = false; loading = false
            return
        }
        searchJob = viewModelScope.launch {
            delay(SEARCH_DEBOUNCE_MS)
            performSearch(q)
        }
    }

    /** Search now — the keyboard's Search action, which shouldn't wait out the debounce. */
    fun runSearch() {
        val q = query.trim()
        if (q.isEmpty()) return
        searchJob?.cancel()
        searchJob = viewModelScope.launch { performSearch(q) }
    }

    /**
     * The actual request. Deliberately does NOT touch searchJob: it runs INSIDE that job, so
     * cancelling from here would cancel the very coroutine doing the work.
     */
    private suspend fun performSearch(q: String) {
        loading = true; error = null
        try {
            results = repo.search(q).results
            searched = true
        } catch (e: CancellationException) {
            throw e // a newer keystroke superseded this search; leave the state to the new job
        } catch (e: Exception) {
            error = "Search failed — check your connection."
        }
        loading = false
    }

    fun create(input: String, onCreated: (String) -> Unit) {
        if (creating) return
        viewModelScope.launch {
            creating = true; error = null
            repo.createNote(input)
                .onSuccess { onCreated(it) }
                .onFailure { error = it.message ?: "Couldn't create the note." }
            creating = false
        }
    }

    private companion object {
        const val SEARCH_DEBOUNCE_MS = 400L
    }
}

@Composable
fun NewNoteScreen(onBack: () -> Unit, onCreated: (String) -> Unit, vm: NewNoteViewModel = viewModel()) {
    val colors = VerbatimTheme.colors
    val fieldColors = OutlinedTextFieldDefaults.colors(
        focusedBorderColor = colors.oxblood, unfocusedBorderColor = colors.hairline,
        focusedTextColor = colors.ink, unfocusedTextColor = colors.ink, cursorColor = colors.oxblood,
        focusedContainerColor = colors.surface, unfocusedContainerColor = colors.surface,
    )

    Column(
        Modifier.fillMaxSize().background(colors.paper).safeDrawingPadding(),
    ) {
        TopBar(title = "New note", onBack = onBack)

        Column(Modifier.padding(horizontal = Space.gutter)) {
            OutlinedTextField(
                value = vm.query,
                onValueChange = { vm.onQueryChange(it) },
                placeholder = { Text("Search a title or paste a link", style = VerbatimText.body, color = colors.muted) },
                textStyle = VerbatimText.body.copy(color = colors.ink),
                singleLine = true,
                shape = Shape.button,
                colors = fieldColors,
                leadingIcon = {
                    Icon(Icons.Filled.Search, contentDescription = null, tint = colors.muted)
                },
                trailingIcon = {
                    // A spinner in the field is the honest place for search progress — it says
                    // "this box is working" without covering the results you're already reading.
                    if (vm.loading) {
                        CircularProgressIndicator(
                            color = colors.oxblood, strokeWidth = 2.dp,
                            modifier = Modifier.size(18.dp),
                        )
                    } else if (vm.query.isNotEmpty()) {
                        IconButton(onClick = { vm.onQueryChange("") }) {
                            Icon(Icons.Filled.Close, contentDescription = "Clear", tint = colors.muted)
                        }
                    }
                },
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                keyboardActions = KeyboardActions(onSearch = { vm.runSearch() }),
                modifier = Modifier.fillMaxWidth(),
            )

            if (vm.looksLikeLink) {
                Spacer(Modifier.height(Space.md))
                PrimaryButton(
                    text = "Create note from link",
                    onClick = { vm.create(vm.query.trim(), onCreated) },
                    loading = vm.creating,
                    modifier = Modifier.fillMaxWidth(),
                )
            }

            vm.error?.let {
                Spacer(Modifier.height(Space.md))
                Text(it, style = VerbatimText.secondary, color = colors.oxblood)
            }
        }

        Spacer(Modifier.height(Space.sm))
        Box(Modifier.fillMaxSize()) {
            when {
                // Creating is the one state worth blocking on: we're about to navigate away.
                vm.creating -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        CircularProgressIndicator(color = colors.oxblood, strokeWidth = 2.dp)
                        Spacer(Modifier.height(Space.lg))
                        Text("Creating your note…", style = VerbatimText.secondary, color = colors.muted)
                    }
                }
                vm.results.isEmpty() && vm.searched && !vm.loading -> EmptyState(
                    icon = Icons.Filled.Search,
                    title = "No videos found",
                    subtitle = "Try different words, or paste the video's link instead.",
                )
                vm.results.isEmpty() && !vm.looksLikeLink -> EmptyState(
                    icon = Icons.Filled.Search,
                    title = "Find something to read",
                    subtitle = "Search by title — or paste a YouTube link and we'll take it from there.",
                )
                else -> LazyColumn(
                    contentPadding = PaddingValues(horizontal = Space.gutter, vertical = Space.sm),
                    verticalArrangement = Arrangement.spacedBy(Space.md),
                ) {
                    items(vm.results, key = { it.videoId }) { r ->
                        ResultRow(r) { vm.create("https://www.youtube.com/watch?v=${r.videoId}", onCreated) }
                    }
                }
            }
        }
    }
}

@Composable
private fun ResultRow(r: SearchResult, onClick: () -> Unit) {
    val colors = VerbatimTheme.colors
    val source = remember { MutableInteractionSource() }
    Row(
        Modifier.fillMaxWidth().pressScale(source).clip(Shape.card).background(colors.panel)
            .clickable(interactionSource = source, indication = null, onClick = onClick).padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        AsyncImage(
            model = r.thumbnail, contentDescription = null, contentScale = ContentScale.Crop,
            modifier = Modifier
                .size(width = 88.dp, height = 58.dp)
                .clip(Shape.thumb)
                .background(colors.hairline.copy(alpha = 0.5f)),
        )
        Spacer(Modifier.width(Space.md))
        Column(Modifier.weight(1f)) {
            Text(r.title, style = VerbatimText.cardTitle, color = colors.ink, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Spacer(Modifier.height(5.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(r.channel, style = VerbatimText.secondary, color = colors.muted, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                r.durationLabel?.let {
                    Spacer(Modifier.width(Space.sm))
                    Text(it, style = VerbatimText.meta, color = colors.muted)
                }
            }
        }
    }
}
