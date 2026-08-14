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
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
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
import com.verbatim.helper.ui.components.FeedSkeleton
import com.verbatim.helper.ui.components.PrimaryButton
import com.verbatim.helper.ui.components.SecondaryButton
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

    // ---- browse feed (trending), shown whenever the search box is empty ----
    var feed by mutableStateOf<List<SearchResult>>(emptyList())
        private set
    var feedLoading by mutableStateOf(false)
        private set
    var feedError by mutableStateOf<String?>(null)
        private set
    private var feedToken: String? = null
    /** Set when the chart runs out of pages, so the list stops asking for more. */
    private var feedExhausted = false
    private var feedJob: Job? = null

    /**
     * What the list above the feed is called.
     *
     * Only the server knows whether it managed to personalise, so it says so and this reads it —
     * never inferred from "the library looks non-empty", which would eventually label the trending
     * fallback as someone's recommendations.
     */
    var feedTitle by mutableStateOf<String?>(null)
        private set

    private var searchJob: Job? = null

    val looksLikeLink: Boolean
        get() = query.trim().let { it.contains("youtu", true) || it.startsWith("http", true) }

    /** True when the browse feed — rather than search results — is what the body should show. */
    val showingFeed: Boolean
        get() = query.trim().isEmpty()

    init {
        loadFeed()
    }

    /**
     * First page of the feed. Cheap enough to do on open: the server's chart call is 1 quota unit
     * and is cached for 15 minutes, so re-entering this screen usually spends nothing at all.
     */
    fun loadFeed(reset: Boolean = false) {
        if (feedLoading) return
        if (reset) { feedToken = null; feedExhausted = false; feed = emptyList() }
        if (feedExhausted) return
        feedJob?.cancel()
        feedJob = viewModelScope.launch {
            feedLoading = true; feedError = null
            try {
                val page = repo.recommendations()
                // YouTube can repeat a video across page boundaries, and a duplicate id would
                // crash LazyColumn's `key`. Dedupe on append rather than trusting the API.
                val seen = feed.mapTo(HashSet()) { it.videoId }
                feed = feed + page.results.filter { seen.add(it.videoId) }
                feedToken = page.nextPageToken
                feedExhausted = page.nextPageToken == null || page.results.isEmpty()
                // Say what the list actually is. Calling generic trending "For you" is a small lie
                // the user catches the first time the personalisation quietly fails.
                feedTitle = when (page.source) {
                    "recommended" -> "For you"
                    "trending" -> "Trending"
                    else -> null // nothing read yet — no feed, and so no heading
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // Only an empty feed is worth an error screen; a failed *next* page just stops
                // paging, because the user still has everything above it to read.
                if (feed.isEmpty()) feedError = "Couldn't load videos — check your connection."
                feedExhausted = true
            }
            feedLoading = false
        }
    }

    /** Called when the feed is scrolled near its end. */
    fun loadMoreFeed() {
        if (!feedLoading && !feedExhausted && feed.isNotEmpty()) loadFeed()
    }

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
            // A pasted link isn't a search term — the Create button handles it. Clearing the box
            // returns to the feed, which is still in memory, so that costs no request.
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
    val feedState = rememberLazyListState()

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

                // A pasted link: the button above is the whole interaction, so say that rather than
                // showing a feed the user has already scrolled past deciding.
                vm.looksLikeLink -> EmptyState(
                    icon = Icons.Filled.Search,
                    title = "Ready when you are",
                    subtitle = "Tap “Create note from link” and we'll fetch this video.",
                )

                // --- browse: the empty box shows the feed, not an empty page ---
                vm.showingFeed -> BrowseFeed(vm, feedState) { r ->
                    vm.create("https://www.youtube.com/watch?v=${r.videoId}", onCreated)
                }

                vm.results.isEmpty() && vm.searched && !vm.loading -> EmptyState(
                    icon = Icons.Filled.Search,
                    title = "No videos found",
                    subtitle = "Try different words, or paste the video's link instead.",
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

/**
 * The scrolling browse feed shown before anyone types — this screen used to open on a search box
 * above a page of nothing, which asks the user to already know what they want.
 *
 * These are YouTube's trending videos, and they are laid out the way a video feed is: one wide
 * card per row rather than the compact rows search uses. Videos too long for the pipeline and
 * live broadcasts are filtered out server-side, so everything here can actually become a note.
 */
@Composable
private fun BrowseFeed(
    vm: NewNoteViewModel,
    state: LazyListState,
    onPick: (SearchResult) -> Unit,
) {
    val colors = VerbatimTheme.colors

    // Ask for the next page a few cards before the bottom, so the list is already longer by the
    // time the user gets there and the scroll never visibly stops.
    val nearEnd by remember(state) {
        derivedStateOf {
            val last = state.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
            val total = state.layoutInfo.totalItemsCount
            total > 0 && last >= total - 3
        }
    }
    LaunchedEffect(state) {
        snapshotFlow { nearEnd }.collect { if (it) vm.loadMoreFeed() }
    }

    when {
        vm.feed.isEmpty() && vm.feedLoading -> FeedSkeleton()

        vm.feed.isEmpty() && vm.feedError != null -> Column(
            Modifier.fillMaxSize().padding(horizontal = Space.gutter),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Text(
                vm.feedError!!, style = VerbatimText.body, color = colors.muted,
                modifier = Modifier.padding(bottom = Space.lg),
            )
            // The feed failing must not take the search box down with it, so this offers the
            // retry and says the box above still works.
            SecondaryButton(text = "Try again", onClick = { vm.loadFeed(reset = true) })
            Spacer(Modifier.height(Space.md))
            Text(
                "You can still search, or paste a link.",
                style = VerbatimText.secondary, color = colors.muted,
            )
        }

        vm.feed.isEmpty() -> EmptyState(
            icon = Icons.Filled.Search,
            title = "Find something to read",
            subtitle = "Search by title — or paste a YouTube link and we'll take it from there.",
        )

        else -> LazyColumn(
            state = state,
            contentPadding = PaddingValues(horizontal = Space.gutter, vertical = Space.sm),
            verticalArrangement = Arrangement.spacedBy(Space.xl),
        ) {
            // Header inside the list, so it scrolls away with the content instead of taking
            // permanent height on a screen whose whole job is browsing.
            vm.feedTitle?.let { title ->
                item(key = "feed-header") {
                    Text(title, style = VerbatimText.cardTitle, color = colors.ink)
                }
            }
            items(vm.feed, key = { it.videoId }) { r -> FeedCard(r) { onPick(r) } }
            if (vm.feedLoading) {
                item {
                    Box(Modifier.fillMaxWidth().padding(Space.lg), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(color = colors.oxblood, strokeWidth = 2.dp, modifier = Modifier.size(20.dp))
                    }
                }
            }
        }
    }
}

/** One feed card: a wide thumbnail with the title and channel beneath it. */
@Composable
private fun FeedCard(r: SearchResult, onClick: () -> Unit) {
    val colors = VerbatimTheme.colors
    val source = remember { MutableInteractionSource() }
    Column(
        Modifier.fillMaxWidth().pressScale(source)
            .clickable(interactionSource = source, indication = null, onClick = onClick),
    ) {
        Box {
            AsyncImage(
                model = r.thumbnail, contentDescription = null, contentScale = ContentScale.Crop,
                modifier = Modifier
                    .fillMaxWidth()
                    .aspectRatio(16f / 9f)
                    .clip(Shape.card)
                    .background(colors.hairline.copy(alpha = 0.5f)),
            )
            // Duration sits on the thumbnail, where every video UI puts it, instead of competing
            // with the channel name for the line below.
            r.durationLabel?.let {
                Text(
                    it,
                    style = VerbatimText.meta,
                    color = colors.paper,
                    modifier = Modifier
                        .align(Alignment.BottomEnd)
                        .padding(Space.sm)
                        .clip(Shape.chip)
                        .background(colors.ink.copy(alpha = 0.78f))
                        .padding(horizontal = 6.dp, vertical = 2.dp),
                )
            }
        }
        Spacer(Modifier.height(Space.sm))
        Text(
            r.title, style = VerbatimText.cardTitle, color = colors.ink,
            maxLines = 2, overflow = TextOverflow.Ellipsis,
        )
        Spacer(Modifier.height(2.dp))
        Text(
            r.channel, style = VerbatimText.secondary, color = colors.muted,
            maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
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
