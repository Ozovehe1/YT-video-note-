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
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.verbatim.helper.data.VerbatimRepository
import com.verbatim.helper.ui.components.Wordmark
import com.verbatim.helper.ui.theme.DisplayFamily
import com.verbatim.helper.ui.theme.ReadFamily
import com.verbatim.helper.ui.theme.SansFamily
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

    fun toggleMode() { isSignUp = !isSignUp; error = null }

    fun submit(onSuccess: () -> Unit) {
        if (email.isBlank() || password.isBlank()) { error = "Enter your email and password."; return }
        viewModelScope.launch {
            loading = true; error = null
            val result = if (isSignUp) repo.signUp(email, password) else repo.signIn(email, password)
            loading = false
            result.onSuccess { onSuccess() }.onFailure { error = it.message ?: "Something went wrong." }
        }
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
            fontSize = 28.sp,
            color = colors.ink,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(8.dp))
        Text(
            text = "Faithful, speaker-attributed reading notes from any video.",
            fontFamily = ReadFamily,
            fontSize = 15.sp,
            color = colors.muted,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(28.dp))

        OutlinedTextField(
            value = vm.email,
            onValueChange = { vm.email = it },
            label = { Text("Email") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
            colors = fieldColors,
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            value = vm.password,
            onValueChange = { vm.password = it },
            label = { Text("Password") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            colors = fieldColors,
            modifier = Modifier.fillMaxWidth(),
        )

        vm.error?.let { err ->
            Spacer(Modifier.height(12.dp))
            Text(err, color = colors.oxblood, fontFamily = SansFamily, fontSize = 13.sp, textAlign = TextAlign.Center)
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
                color = colors.muted, fontFamily = SansFamily, fontSize = 14.sp,
            )
        }
    }
}
