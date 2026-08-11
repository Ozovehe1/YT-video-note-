package com.verbatim.helper.ui.auth

import android.app.Application
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.verbatim.helper.data.VerbatimRepository
import com.verbatim.helper.data.remote.EmailConfirmationRequired
import com.verbatim.helper.ui.components.PrimaryButton
import com.verbatim.helper.ui.components.Wordmark
import com.verbatim.helper.ui.theme.DisplayFamily
import com.verbatim.helper.ui.theme.ReadFamily
import com.verbatim.helper.ui.theme.Shape
import com.verbatim.helper.ui.theme.Space
import com.verbatim.helper.ui.theme.VerbatimText
import com.verbatim.helper.ui.theme.VerbatimTheme
import kotlinx.coroutines.launch

class AuthViewModel(app: Application) : AndroidViewModel(app) {
    private val repo = VerbatimRepository.get(app)

    var email by mutableStateOf("")
    var password by mutableStateOf("")
    var isSignUp by mutableStateOf(false)
    var loading by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    /** A neutral, non-failure message — currently only "check your email to confirm". */
    var notice by mutableStateOf<String?>(null)
        private set
    var passwordVisible by mutableStateOf(false)

    fun toggleMode() { isSignUp = !isSignUp; error = null; notice = null }

    fun togglePasswordVisible() { passwordVisible = !passwordVisible }

    fun submit(onSuccess: () -> Unit) {
        if (email.isBlank() || password.isBlank()) { error = "Enter your email and password."; return }
        // Supabase rejects anything shorter, and catching it here costs a round trip less than
        // letting the server say it.
        if (isSignUp && password.length < MIN_PASSWORD) {
            error = "Use at least $MIN_PASSWORD characters for your password."
            return
        }
        viewModelScope.launch {
            loading = true; error = null; notice = null
            val result = if (isSignUp) repo.signUp(email, password) else repo.signIn(email, password)
            loading = false
            result
                .onSuccess { onSuccess() }
                .onFailure {
                    if (it is EmailConfirmationRequired) {
                        // The account WAS created. Show it as news, and move the form to sign-in so
                        // the obvious next step is the one in front of them.
                        notice = it.message
                        isSignUp = false
                    } else {
                        error = it.message ?: "Something went wrong."
                    }
                }
        }
    }

    private companion object {
        const val MIN_PASSWORD = 6
    }
}

@Composable
fun AuthScreen(onSignedIn: () -> Unit, vm: AuthViewModel = viewModel()) {
    val colors = VerbatimTheme.colors
    val fieldColors = OutlinedTextFieldDefaults.colors(
        focusedBorderColor = colors.oxblood,
        unfocusedBorderColor = colors.hairline,
        focusedTextColor = colors.ink,
        unfocusedTextColor = colors.ink,
        cursorColor = colors.oxblood,
        focusedContainerColor = colors.surface,
        unfocusedContainerColor = colors.surface,
        focusedLabelColor = colors.oxblood,
        unfocusedLabelColor = colors.muted,
    )

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(colors.paper)
            .safeDrawingPadding()
            .imePadding()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 28.dp, vertical = 40.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Wordmark()
        Spacer(Modifier.height(20.dp))
        Text(
            text = if (vm.isSignUp) "Create your account" else "Welcome back",
            fontFamily = DisplayFamily,
            fontWeight = FontWeight.SemiBold,
            fontSize = 30.sp,
            lineHeight = 36.sp,
            color = colors.ink,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(Space.sm))
        Text(
            text = "Faithful, speaker-attributed reading notes from any video.",
            fontFamily = ReadFamily,
            fontSize = 16.sp,
            lineHeight = 23.sp,
            color = colors.muted,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(28.dp))

        OutlinedTextField(
            value = vm.email,
            onValueChange = { vm.email = it },
            label = { Text("Email") },
            singleLine = true,
            shape = Shape.button,
            keyboardOptions = KeyboardOptions(
                keyboardType = KeyboardType.Email,
                imeAction = ImeAction.Next,
            ),
            colors = fieldColors,
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(Space.md))
        OutlinedTextField(
            value = vm.password,
            onValueChange = { vm.password = it },
            label = { Text("Password") },
            singleLine = true,
            shape = Shape.button,
            // A reveal toggle. Typing a password blind on a phone keyboard is the single most
            // common reason a correct password gets rejected.
            visualTransformation = if (vm.passwordVisible) VisualTransformation.None else PasswordVisualTransformation(),
            trailingIcon = {
                IconButton(onClick = { vm.togglePasswordVisible() }) {
                    Icon(
                        if (vm.passwordVisible) Icons.Filled.VisibilityOff else Icons.Filled.Visibility,
                        contentDescription = if (vm.passwordVisible) "Hide password" else "Show password",
                        tint = colors.muted,
                    )
                }
            },
            keyboardOptions = KeyboardOptions(
                keyboardType = KeyboardType.Password,
                imeAction = ImeAction.Done,
            ),
            // Enter submits, so the flow finishes without hunting for the button.
            keyboardActions = KeyboardActions(onDone = { vm.submit(onSignedIn) }),
            colors = fieldColors,
            modifier = Modifier.fillMaxWidth(),
        )

        vm.notice?.let { msg ->
            Spacer(Modifier.height(Space.md))
            Text(msg, style = VerbatimText.secondary, color = colors.ink, textAlign = TextAlign.Center)
        }
        vm.error?.let { err ->
            Spacer(Modifier.height(Space.md))
            Text(err, style = VerbatimText.secondary, color = colors.oxblood, textAlign = TextAlign.Center)
        }

        Spacer(Modifier.height(20.dp))
        PrimaryButton(
            text = if (vm.isSignUp) "Create account" else "Sign in",
            onClick = { vm.submit(onSignedIn) },
            loading = vm.loading,
            modifier = Modifier.fillMaxWidth(),
        )

        Spacer(Modifier.height(10.dp))
        TextButton(onClick = { vm.toggleMode() }) {
            Text(
                if (vm.isSignUp) "Have an account? Sign in" else "New here? Create an account",
                style = VerbatimText.body, color = colors.muted,
            )
        }
    }
}
