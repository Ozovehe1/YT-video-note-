package com.verbatim.helper.ui

/** Navigation destinations. */
object Routes {
    const val AUTH = "auth"
    const val LIBRARY = "library"
    const val NEW = "new"
    const val SETTINGS = "settings"
    const val READER = "reader/{id}"
    fun reader(id: String) = "reader/$id"
}
