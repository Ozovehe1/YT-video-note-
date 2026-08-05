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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import coil.compose.AsyncImage
import com.verbatim.helper.data.VerbatimRepository
import com.verbatim.helper.data.model.SearchResult
import com.verbatim.helper.ui.components.PrimaryButton
import com.verbatim.helper.ui.theme.DisplayFamily
import com.verbatim.helper.ui.theme.MonoFamily
import com.verbatim.helper.ui.theme.SansFamily
import com.verbatim.helper.ui.theme.Shape
import com.verbatim.helper.ui.theme.VerbatimTheme
import com.verbatim.helper.ui.theme.pressScale
import kotlinx.coroutines.launch

class NewNoteViewModel(app: Application) : AndroidViewModel(app) {
    private val repo = VerbatimRepository.get(app)

    var query by mutableStateOf("")
    var results by mutableStateOf<List<SearchResult>>(emptyList())
        private set
    var loading by mutableStateOf(false)
        private set
    var creating by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set

    val looksLikeLink: Boolean
        get() = query.trim().let { it.contains("youtu", true) || it.startsWith("http", true) }

    fun runSearch() {
        val q = query.trim()
        if (q.isEmpty()) return
        viewModelScope.launch {
            loading = true; error = null
            try {
                results = repo.search(q).results
            } catch (e: Exception) {
                error = "Search failed — check your connection."
            }
            loading = false
        }
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
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", tint = colors.ink)
            }
            Text("New note", fontFamily = DisplayFamily, fontWeight = FontWeight.SemiBold, fontSize = 20.sp, color = colors.ink)
        }

        Column(Modifier.padding(horizontal = 20.dp)) {
            OutlinedTextField(
                value = vm.query,
                onValueChange = { vm.query = it },
                placeholder = { Text("Search a title or paste a link", color = colors.muted) },
                singleLine = true,
                colors = fieldColors,
                trailingIcon = {
                    IconButton(onClick = { vm.runSearch() }) {
                        Icon(Icons.Filled.Search, contentDescription = "Search", tint = colors.oxblood)
                    }
                },
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                keyboardActions = KeyboardActions(onSearch = { vm.runSearch() }),
                modifier = Modifier.fillMaxWidth(),
            )

            if (vm.looksLikeLink) {
                Spacer(Modifier.height(10.dp))
                PrimaryButton(
                    text = "Create note from link",
                    onClick = { vm.create(vm.query.trim(), onCreated) },
                    loading = vm.creating,
                    modifier = Modifier.fillMaxWidth(),
                )
            }

            vm.error?.let {
                Spacer(Modifier.height(10.dp))
                Text(it, color = colors.oxblood, fontFamily = SansFamily, fontSize = 13.sp)
            }
        }

        Spacer(Modifier.height(8.dp))
        Box(Modifier.fillMaxSize()) {
            LazyColumn(
                contentPadding = PaddingValues(horizontal = 20.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                items(vm.results, key = { it.videoId }) { r ->
                    ResultRow(r) { vm.create("https://www.youtube.com/watch?v=${r.videoId}", onCreated) }
                }
            }
            if (vm.loading || vm.creating) {
                Box(Modifier.fillMaxSize().background(colors.paper.copy(alpha = 0.6f)), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = colors.oxblood, strokeWidth = 2.dp)
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
            modifier = Modifier.size(width = 84.dp, height = 56.dp).clip(RoundedCornerShape(8.dp)),
        )
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(r.title, fontFamily = DisplayFamily, fontWeight = FontWeight.SemiBold, fontSize = 15.sp, color = colors.ink, maxLines = 2, overflow = TextOverflow.Ellipsis, lineHeight = 19.sp)
            Spacer(Modifier.height(4.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(r.channel, fontFamily = SansFamily, fontSize = 12.sp, color = colors.muted, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                r.durationLabel?.let {
                    Spacer(Modifier.width(8.dp))
                    Text(it, fontFamily = MonoFamily, fontSize = 11.sp, color = colors.oxblood)
                }
            }
        }
    }
}
